import type { AgentRunner } from "@/agent.js";
import { runIdFromDate } from "@/branching.js";
import { createLimiter, mapLimit } from "@/concurrency.js";
import { GitClient } from "@/git.js";
import { GitHubClient } from "@/github.js";
import { loadOpenPrGraph, type OpenPrNode } from "@/open-pr-graph.js";
import { preparePullRequestReview } from "@/review.js";
import type { AgentTrainConfig, PullRequest, ReviewFinding } from "@/types.js";

export interface ValidateInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly pullNumbers?: readonly number[];
  readonly repair?: boolean;
  readonly runId?: string;
}

export interface ValidateDeps {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly agent: AgentRunner;
  readonly log?: (message: string) => void;
}

export interface PullRequestValidationResult {
  readonly pr: Pick<
    PullRequest,
    "number" | "url" | "headRefName" | "baseRefName" | "headRefOid"
  >;
  readonly issueNumber?: number;
  readonly status: "validated" | "validation_failed";
  readonly blockingFindings: number;
  readonly advisoryFindings: number;
  readonly repaired: boolean;
  readonly specSkipped: boolean;
  readonly reviewEvent: "COMMENT" | "REQUEST_CHANGES";
}

export interface ValidateResult {
  readonly repo: string;
  readonly checkedAt: string;
  readonly pullRequests: readonly PullRequestValidationResult[];
}

export async function executeValidate(
  input: ValidateInput,
  deps: ValidateDeps
): Promise<ValidateResult> {
  const runId = input.runId ?? runIdFromDate("validate");
  const graph = await loadOpenPrGraph({
    github: deps.github,
    repo: input.config.repo,
    targetBranch: input.config.targetBranch,
    concurrency: input.config.concurrency.github,
  });
  const nodes = selectedNodes(graph, input.pullNumbers);
  const githubMutate = createLimiter(input.config.concurrency.github);
  const gitMutate = createLimiter(1);
  const checkedAt = new Date().toISOString();

  const pullRequests = await mapLimit(
    nodes,
    input.config.concurrency.validate,
    async (node): Promise<PullRequestValidationResult> => {
      deps.log?.(
        node.issue
          ? `Validating PR #${node.pr.number} for issue #${node.issue.number}`
          : `Validating PR #${node.pr.number} with Standards only`
      );

      await gitMutate(() =>
        deps.git.prepareBranchFromBase(node.pr.headRefName, node.pr.baseRefName)
      );

      let pr = await deps.github.getPullRequest(
        input.config.repo,
        node.pr.number
      );
      let diff = await deps.github.getPullRequestDiff(
        input.config.repo,
        pr.number
      );
      let findings = await collectFindings(input, deps, runId, node, pr, diff);
      let repaired = false;

      const blockingFindings = findings.filter(
        (finding) => finding.severity === "blocking"
      );
      if ((input.repair ?? true) && blockingFindings.length > 0) {
        const outcome = await deps.agent.repairPullRequest({
          cwd: input.cwd,
          config: input.config,
          runId,
          issue: node.issue,
          relatedIssues: node.relatedIssues,
          prNumber: pr.number,
          branch: pr.headRefName,
          baseBranch: pr.baseRefName,
          findings: blockingFindings,
        });

        if (outcome.commits.length > 0) {
          repaired = true;
          await gitMutate(() => deps.git.pushBranch(pr.headRefName));
          pr = await deps.github.getPullRequest(input.config.repo, pr.number);
          diff = await deps.github.getPullRequestDiff(
            input.config.repo,
            pr.number
          );
          findings = await collectFindings(input, deps, runId, node, pr, diff);
        }
      }

      const specSkipped = !node.issue;
      const preparedReview = preparePullRequestReview({
        pr,
        diff,
        findings,
        specSkipped,
      });

      await githubMutate(() =>
        deps.github.createPullRequestReview({
          repo: input.config.repo,
          pullNumber: pr.number,
          commitId: pr.headRefOid,
          event: preparedReview.event,
          body: preparedReview.body,
          comments: preparedReview.comments,
        })
      );

      const blockingCount = findings.filter(
        (finding) => finding.severity === "blocking"
      ).length;
      const advisoryCount = findings.length - blockingCount;
      return {
        pr: {
          number: pr.number,
          url: pr.url,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          headRefOid: pr.headRefOid,
        },
        issueNumber: node.issue?.number,
        status: blockingCount === 0 ? "validated" : "validation_failed",
        blockingFindings: blockingCount,
        advisoryFindings: advisoryCount,
        repaired,
        specSkipped,
        reviewEvent: preparedReview.event,
      };
    }
  );

  return {
    repo: input.config.repo,
    checkedAt,
    pullRequests,
  };
}

async function collectFindings(
  input: ValidateInput,
  deps: ValidateDeps,
  runId: string,
  node: OpenPrNode,
  pr: PullRequest,
  diff: string
): Promise<ReviewFinding[]> {
  const standards = deps.agent.reviewPullRequest({
    cwd: input.cwd,
    config: input.config,
    runId,
    issue: node.issue,
    relatedIssues: node.relatedIssues,
    prNumber: pr.number,
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    diff,
    axis: "standards",
  });

  const reviews = node.issue
    ? await Promise.all([
        standards,
        deps.agent.reviewPullRequest({
          cwd: input.cwd,
          config: input.config,
          runId,
          issue: node.issue,
          relatedIssues: node.relatedIssues,
          prNumber: pr.number,
          branch: pr.headRefName,
          baseBranch: pr.baseRefName,
          diff,
          axis: "spec",
        }),
      ])
    : [await standards];

  return reviews.flatMap((review) => review.findings);
}

function selectedNodes(
  graph: Awaited<ReturnType<typeof loadOpenPrGraph>>,
  pullNumbers?: readonly number[]
): OpenPrNode[] {
  const wanted = pullNumbers ? new Set(pullNumbers) : undefined;
  const nodes = graph.topologicalOrder
    .map((prNumber) => graph.nodes.get(prNumber))
    .filter((node): node is OpenPrNode =>
      Boolean(node && (!wanted || wanted.has(node.pr.number)))
    );

  if (wanted) {
    const found = new Set(nodes.map((node) => node.pr.number));
    const missing = [...wanted].filter((prNumber) => !found.has(prNumber));
    if (missing.length > 0) {
      throw new Error(
        `Open PR(s) not found in ${graph.topologicalOrder.length} loaded PRs: ${missing.map((number) => `#${number}`).join(", ")}.`
      );
    }
  }

  return nodes;
}
