import type { AgentTrainConfig, IssueTrainRecord, TrainState } from "../types.js";
import { GitHubClient, isPullRequestGreen } from "../github.js";
import { GitClient } from "../git.js";
import { buildIssueGraph, descendantsOf, planBranches } from "../graph.js";
import { loadTrainState, saveTrainState, updateIssueRecord, updateSyntheticBase } from "../state.js";
import { selectedIssuesFromState } from "./create-prs.js";
import { buildPullRequestBody } from "../pr-body.js";

export interface MergeInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly trainId: string;
  readonly validateAffected?: boolean;
}

export interface MergeDeps {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly validateIssues?: (issueNumbers: readonly number[]) => Promise<void>;
  readonly log?: (message: string) => void;
}

export async function executeMerge(input: MergeInput, deps: MergeDeps): Promise<TrainState> {
  let state = await loadTrainState(input.cwd, input.trainId);
  const graph = buildIssueGraph(selectedIssuesFromState(state));

  for (const issueNumber of graph.topologicalOrder) {
    const record = state.issues[String(issueNumber)];
    if (!record || record.status === "merged") continue;
    if (!record.pr) {
      throw new Error(`Issue #${issueNumber} has no PR yet.`);
    }
    if (!record.validation || record.validation.blockingFindings > 0) {
      throw new Error(`Issue #${issueNumber} is not validated cleanly.`);
    }

    const pr = await deps.github.getPullRequest(input.config.repo, record.pr.number);
    const green = isPullRequestGreen(pr);
    if (!green.ok) {
      throw new Error(green.reason);
    }

    deps.log?.(`Squash-merging PR #${pr.number} for issue #${issueNumber}`);
    await deps.github.mergePullRequest(input.config.repo, pr.number, pr.headRefOid, "squash");
    const mergedPr = await deps.github.waitForPullRequestMerged(input.config.repo, pr.number);
    state = updateIssueRecord(state, issueNumber, {
      status: "merged",
      pr: {
        number: mergedPr.number,
        url: mergedPr.url,
        headRefName: mergedPr.headRefName,
        baseRefName: mergedPr.baseRefName,
        headRefOid: mergedPr.headRefOid,
      },
    });
    await saveTrainState(input.cwd, state);

    const affected = descendantsOf(graph, issueNumber).filter((descendant) => {
      const descendantRecord = state.issues[String(descendant)];
      return descendantRecord && descendantRecord.status !== "merged";
    });

    if (affected.length > 0) {
      state = await restackDescendants(input, deps, state, affected);
      await saveTrainState(input.cwd, state);

      if (input.validateAffected ?? true) {
        await deps.validateIssues?.(affected);
        state = await loadTrainState(input.cwd, input.trainId);
      }
    }
  }

  await cleanupMergedBranches(input, deps, state);
  return state;
}

async function restackDescendants(
  input: MergeInput,
  deps: MergeDeps,
  state: TrainState,
  affected: readonly number[],
): Promise<TrainState> {
  const graph = buildIssueGraph(selectedIssuesFromState(state));
  const branchPlan = planBranches(graph, input.config, input.trainId);
  let nextState = state;

  for (const issueNumber of affected) {
    const record = nextState.issues[String(issueNumber)];
    const planned = branchPlan.issues.get(issueNumber);
    if (!record || !planned || record.status === "merged") continue;

    const openBlockerBranches = planned.blockers
      .map((blocker) => nextState.issues[String(blocker)])
      .filter(
        (blockerRecord): blockerRecord is IssueTrainRecord =>
          Boolean(blockerRecord) && blockerRecord.status !== "merged",
      )
      .map((blockerRecord) => blockerRecord.branch);

    const nextBase =
      openBlockerBranches.length === 0
        ? input.config.targetBranch
        : openBlockerBranches.length === 1
          ? openBlockerBranches[0]!
          : planned.syntheticBase!;

    if (planned.syntheticBase && openBlockerBranches.length > 1) {
      await deps.git.createSyntheticBaseBranch({
        trainId: input.trainId,
        issueNumber,
        syntheticBranch: planned.syntheticBase,
        blockerBranches: openBlockerBranches,
      });
      nextState = updateSyntheticBase(nextState, issueNumber, {
        branch: planned.syntheticBase,
        blockers: planned.blockers,
        status: "created",
      });
    } else if (planned.syntheticBase) {
      nextState = updateSyntheticBase(nextState, issueNumber, {
        status: "obsolete",
      });
    }

    const baseAnchorSha = await deps.git.rebaseBranchOntoBase({
      trainId: input.trainId,
      issueNumber,
      branch: record.branch,
      baseBranch: nextBase,
      oldBaseAnchorSha: record.baseAnchorSha,
    });

    if (record.pr && record.baseBranch !== nextBase) {
      await deps.github.editPullRequestBase(input.config.repo, record.pr.number, nextBase);
    }

    nextState = updateIssueRecord(nextState, issueNumber, {
      baseBranch: nextBase,
      baseAnchorSha,
      syntheticBase: openBlockerBranches.length > 1 ? planned.syntheticBase : undefined,
      pr: record.pr ? { ...record.pr, baseRefName: nextBase } : undefined,
      validation: undefined,
      status: record.status === "validated" ? "pr_opened" : record.status,
    });
    const updatedRecord = nextState.issues[String(issueNumber)]!;
    if (updatedRecord.pr) {
      await deps.github.editPullRequestBody(
        input.config.repo,
        updatedRecord.pr.number,
        buildPullRequestBody(updatedRecord, input.trainId),
      );
    }
  }

  return nextState;
}

async function cleanupMergedBranches(input: MergeInput, deps: MergeDeps, state: TrainState): Promise<void> {
  for (const record of Object.values(state.issues)) {
    if (record.status === "merged") {
      await deps.git.deleteRemoteBranch(record.branch);
    }
  }

  for (const synthetic of Object.values(state.syntheticBases)) {
    if (synthetic.status === "obsolete") {
      await deps.git.deleteRemoteBranch(synthetic.branch);
    }
  }
}
