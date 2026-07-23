import type { AgentRunner } from "../agent.js";
import type { AgentTrainConfig, Issue, IssueTrainRecord, ReviewFinding, TrainState } from "../types.js";
import { GitHubClient } from "../github.js";
import { GitClient } from "../git.js";
import { loadTrainState, saveTrainState, updateIssueRecord } from "../state.js";
import { createLimiter, mapLimit } from "../concurrency.js";
import { preparePullRequestReview } from "../review.js";

export interface ValidateInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly trainId: string;
  readonly issueNumbers?: readonly number[];
  readonly repair?: boolean;
}

export interface ValidateDeps {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly agent: AgentRunner;
  readonly log?: (message: string) => void;
}

export async function executeValidate(input: ValidateInput, deps: ValidateDeps): Promise<TrainState> {
  let state = await loadTrainState(input.cwd, input.trainId);
  const githubMutate = createLimiter(input.config.concurrency.github);
  const gitMutate = createLimiter(1);
  const stateMutation = createLimiter(1);
  const issueNumbers = input.issueNumbers ?? Object.values(state.issues).map((record) => record.issue.number);
  const wanted = new Set(issueNumbers);
  const records = Object.values(state.issues).filter(
    (record) => wanted.has(record.issue.number) && record.pr && record.status !== "merged",
  );

  const persistIssue = async (
    issueNumber: number,
    update: Partial<IssueTrainRecord>,
  ): Promise<IssueTrainRecord> =>
    stateMutation(async () => {
      state = updateIssueRecord(state, issueNumber, update);
      await saveTrainState(input.cwd, state);
      return state.issues[String(issueNumber)]!;
    });

  await mapLimit(records, input.config.concurrency.validate, async (record) => {
    deps.log?.(`Validating PR #${record.pr!.number} for issue #${record.issue.number}`);
    await persistIssue(record.issue.number, { status: "validating", lastError: undefined });
    await gitMutate(() => deps.git.prepareBranchFromBase(record.branch, record.baseBranch));

    let pr = await deps.github.getPullRequest(input.config.repo, record.pr!.number);
    let diff = await deps.github.getPullRequestDiff(input.config.repo, pr.number);
    const relatedIssues = await deps.github.getRelatedIssues(input.config.repo, record.issue);
    let findings = await collectFindings(input, deps, record.issue.number, pr.number, record.branch, record.baseBranch, diff, relatedIssues);
    let repaired = false;

    const blockingFindings = findings.filter((finding) => finding.severity === "blocking");
    if ((input.repair ?? true) && blockingFindings.length > 0) {
      const outcome = await deps.agent.repairPullRequest({
        cwd: input.cwd,
        config: input.config,
        trainId: input.trainId,
        issue: record.issue,
        relatedIssues,
        branch: record.branch,
        baseBranch: record.baseBranch,
        findings: blockingFindings,
      });

      if (outcome.commits.length > 0) {
        repaired = true;
        await gitMutate(() => deps.git.pushBranch(record.branch));
        pr = await deps.github.getPullRequest(input.config.repo, pr.number);
        diff = await deps.github.getPullRequestDiff(input.config.repo, pr.number);
        findings = await collectFindings(
          input,
          deps,
          record.issue.number,
          pr.number,
          record.branch,
          record.baseBranch,
          diff,
          relatedIssues,
        );
      }
    }

    const preparedReview = preparePullRequestReview({
      pr,
      diff,
      findings,
    });

    await githubMutate(() =>
      deps.github.createPullRequestReview({
        repo: input.config.repo,
        pullNumber: pr.number,
        commitId: pr.headRefOid,
        event: preparedReview.event,
        body: preparedReview.body,
        comments: preparedReview.comments,
      }),
    );

    const blockingCount = findings.filter((finding) => finding.severity === "blocking").length;
    const advisoryCount = findings.length - blockingCount;
    await persistIssue(record.issue.number, {
      status: blockingCount === 0 ? "validated" : "validation_failed",
      pr: {
        number: pr.number,
        url: pr.url,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        headRefOid: pr.headRefOid,
      },
      validation: {
        checkedAt: new Date().toISOString(),
        blockingFindings: blockingCount,
        advisoryFindings: advisoryCount,
        reviewEvent: preparedReview.event,
        repaired,
      },
    });
  });

  return state;
}

async function collectFindings(
  input: ValidateInput,
  deps: ValidateDeps,
  issueNumber: number,
  prNumber: number,
  branch: string,
  baseBranch: string,
  diff: string,
  relatedIssues: readonly Issue[],
): Promise<ReviewFinding[]> {
  const state = await loadTrainState(input.cwd, input.trainId);
  const record = state.issues[String(issueNumber)];
  if (!record) throw new Error(`Issue #${issueNumber} is not part of train ${input.trainId}.`);

  const [standards, spec] = await Promise.all([
    deps.agent.reviewPullRequest({
      cwd: input.cwd,
      config: input.config,
      trainId: input.trainId,
      issue: record.issue,
      relatedIssues,
      prNumber,
      branch,
      baseBranch,
      diff,
      axis: "standards",
    }),
    deps.agent.reviewPullRequest({
      cwd: input.cwd,
      config: input.config,
      trainId: input.trainId,
      issue: record.issue,
      relatedIssues,
      prNumber,
      branch,
      baseBranch,
      diff,
      axis: "spec",
    }),
  ]);

  return [...standards.findings, ...spec.findings];
}
