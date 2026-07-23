import type { AgentRunner } from "../agent.js";
import type { AgentTrainConfig, Issue, IssueTrainRecord, SyntheticBaseRecord, TrainState } from "../types.js";
import { GitHubClient } from "../github.js";
import { GitClient } from "../git.js";
import { buildIssueGraph, planBranches } from "../graph.js";
import { trainIdFromDate } from "../branching.js";
import {
  createTrainState,
  loadTrainState,
  reconcileTrainState,
  saveTrainState,
  trainStatePath,
  updateIssueRecord,
  updateSyntheticBase,
} from "../state.js";
import { buildPullRequestBody } from "../pr-body.js";
import { pathExists } from "../fs.js";
import { createLimiter, mapLimit } from "../concurrency.js";

export interface CreatePrsInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly trainId?: string;
  readonly dryRun?: boolean;
}

export interface CreatePrsDeps {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly agent: AgentRunner;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export async function executeCreatePrs(input: CreatePrsInput, deps: CreatePrsDeps): Promise<TrainState> {
  const issues = await deps.github.listIssues(input.config);
  const graph = buildIssueGraph(issues);
  const trainId = input.trainId ?? trainIdFromDate(deps.now?.() ?? new Date());
  const branchPlan = planBranches(graph, input.config, trainId);
  const existingStatePath = trainStatePath(input.cwd, trainId);
  const githubMutate = createLimiter(input.config.concurrency.github);
  const gitMutate = createLimiter(1);
  const stateMutation = createLimiter(1);
  const now = deps.now?.() ?? new Date();
  let state = (await pathExists(existingStatePath))
    ? reconcileTrainState(await loadTrainState(input.cwd, trainId), input.config, graph, branchPlan, now)
    : createTrainState(trainId, input.config, graph, branchPlan, now);

  await saveTrainState(input.cwd, state);

  const persistIssue = async (
    issueNumber: number,
    update: Partial<IssueTrainRecord>,
  ): Promise<IssueTrainRecord> =>
    stateMutation(async () => {
      state = updateIssueRecord(state, issueNumber, update);
      await saveTrainState(input.cwd, state);
      return state.issues[String(issueNumber)]!;
    });

  const persistSynthetic = async (
    issueNumber: number,
    update: Partial<SyntheticBaseRecord>,
  ): Promise<void> =>
    stateMutation(async () => {
      state = updateSyntheticBase(state, issueNumber, update);
      await saveTrainState(input.cwd, state);
    });

  const persistBlockedSynthetic = async (
    issueNumber: number,
    syntheticUpdate: Partial<SyntheticBaseRecord>,
    message: string,
  ): Promise<void> =>
    stateMutation(async () => {
      state = updateSyntheticBase(state, issueNumber, syntheticUpdate);
      state = updateIssueRecord(state, issueNumber, { status: "blocked", lastError: message });
      await saveTrainState(input.cwd, state);
    });

  for (const layer of graph.layers) {
    deps.log?.(`Implementing layer: ${layer.map((issueNumber) => `#${issueNumber}`).join(", ")}`);

    await mapLimit(layer, input.config.concurrency.implement, async (issueNumber) => {
      const node = graph.nodes.get(issueNumber);
      if (!node) return;

      let record = state.issues[String(issueNumber)];
      if (!record || record.status === "pr_opened" || record.status === "validated" || record.status === "merged") {
        return;
      }

      if (node.externalOpenBlockers.length > 0) {
        const message = `Issue #${issueNumber} is blocked by issue(s) outside this train: ${node.externalOpenBlockers
          .map((blocker) => `#${blocker}`)
          .join(", ")}.`;
        await persistIssue(issueNumber, { status: "blocked", lastError: message });
        await githubMutate(() =>
          deps.github.createIssueComment(input.config.repo, issueNumber, `Agent train blocked: ${message}`),
        );
        return;
      }

      const blockerBranchMissing = await firstMissingBlockerBranch(record.blockers, state, deps.git);
      if (blockerBranchMissing !== undefined) {
        const message = `Issue #${issueNumber} is waiting for blocker branch ${blockerBranchMissing} to exist on ${input.config.remote}.`;
        await persistIssue(issueNumber, { status: "blocked", lastError: message });
        await githubMutate(() =>
          deps.github.createIssueComment(input.config.repo, issueNumber, `Agent train blocked: ${message}`),
        );
        return;
      }

      const blockedByFailedTrainIssue = record.blockers.find((blocker) => {
        const blockerRecord = state.issues[String(blocker)];
        return !blockerRecord || blockerRecord.status === "blocked";
      });
      if (blockedByFailedTrainIssue !== undefined) {
        const message = `Issue #${issueNumber} is blocked because train blocker #${blockedByFailedTrainIssue} did not produce a branch.`;
        await persistIssue(issueNumber, { status: "blocked", lastError: message });
        await githubMutate(() =>
          deps.github.createIssueComment(input.config.repo, issueNumber, `Agent train blocked: ${message}`),
        );
        return;
      }

      if (record.syntheticBase) {
        try {
          await gitMutate(() =>
            deps.git.createSyntheticBaseBranch({
              trainId,
              issueNumber,
              syntheticBranch: record.syntheticBase,
              blockerBranches: record.blockers.map((blocker) => state.issues[String(blocker)]!.branch),
            }),
          );
          await persistSynthetic(issueNumber, { status: "created" });
        } catch (error) {
          const message = `Synthetic base ${record.syntheticBase} failed: ${errorMessage(error)}`;
          await persistBlockedSynthetic(issueNumber, { status: "failed", lastError: message }, message);
          await githubMutate(() =>
            deps.github.createIssueComment(input.config.repo, issueNumber, `Agent train blocked: ${message}`),
          );
          return;
        }
      }

      if (input.dryRun) {
        await persistIssue(issueNumber, { status: "planned" });
        return;
      }

      let baseAnchorSha: string;
      try {
        baseAnchorSha = await gitMutate(() => deps.git.revParseRemoteBranch(record.baseBranch));
      } catch (error) {
        const message = `Unable to resolve base branch ${record.baseBranch}: ${errorMessage(error)}`;
        await persistIssue(issueNumber, { status: "blocked", lastError: message });
        await githubMutate(() =>
          deps.github.createIssueComment(input.config.repo, issueNumber, `Agent train blocked: ${message}`),
        );
        return;
      }

      record = await persistIssue(issueNumber, {
        status: "implementing",
        lastError: undefined,
        baseAnchorSha,
      });

      await gitMutate(() => deps.git.prepareBranchFromBase(record.branch, record.baseBranch));
      const relatedIssues = await deps.github.getRelatedIssues(input.config.repo, record.issue);
      const outcome = await deps.agent.implementIssue({
        cwd: input.cwd,
        config: input.config,
        trainId,
        issue: record.issue,
        relatedIssues,
        targetBranch: input.config.targetBranch,
        baseBranch: record.baseBranch,
        branch: record.branch,
      });

      if (outcome.commits.length === 0) {
        const message = `Codex completed issue #${issueNumber} without creating commits.`;
        await persistIssue(issueNumber, { status: "blocked", lastError: message });
        await githubMutate(() =>
          deps.github.createIssueComment(input.config.repo, issueNumber, `Agent train blocked: ${message}`),
        );
        return;
      }

      await gitMutate(() => deps.git.pushBranch(record.branch));
      record = await persistIssue(issueNumber, {
        commits: outcome.commits,
        status: "pr_opened",
      });

      const pr = await githubMutate(() =>
        deps.github.createOrUpdatePullRequest({
          repo: input.config.repo,
          title: `#${record.issue.number}: ${record.issue.title}`,
          body: buildPullRequestBody(record, trainId),
          baseBranch: record.baseBranch,
          headBranch: record.branch,
        }),
      );

      await persistIssue(issueNumber, {
        status: "pr_opened",
        pr: {
          number: pr.number,
          url: pr.url,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          headRefOid: pr.headRefOid,
        },
      });
    });
  }

  return state;
}

export function selectedIssuesFromState(state: TrainState): Issue[] {
  return Object.values(state.issues).map((record) => record.issue);
}

async function firstMissingBlockerBranch(
  blockers: readonly number[],
  state: TrainState,
  git: GitClient,
): Promise<string | undefined> {
  for (const blocker of blockers) {
    const blockerRecord = state.issues[String(blocker)];
    if (!blockerRecord) return `#${blocker}`;
    if (blockerRecord.status === "blocked") continue;
    if (!(await git.branchExistsOnRemote(blockerRecord.branch))) {
      return blockerRecord.branch;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
