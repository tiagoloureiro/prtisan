import { mapLimit } from "./concurrency.js";
import type { GitHubClient } from "./github.js";
import { GitHubIssueContext } from "./issue-context.js";
import {
  loadOpenPrGraph,
  type OpenPrGraph,
  type OpenPrNode,
} from "./open-pr-graph.js";
import type { Issue, PullRequest } from "./types.js";
import type { ValidationScope } from "./types.js";

export type PullRequestSummary = Pick<
  PullRequest,
  "number" | "url" | "headRefName" | "baseRefName" | "headRefOid"
>;

export interface IssueValidationJob {
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly associatedOpenPullRequests: readonly PullRequestSummary[];
}

export interface ValidationPlan {
  readonly graph: OpenPrGraph;
  readonly pullRequestJobs: readonly OpenPrNode[];
  readonly issueJobs: readonly IssueValidationJob[];
}

export async function buildValidationPlan(input: {
  readonly github: GitHubClient;
  readonly repo: string;
  readonly targetBranch: string;
  readonly pullNumbers?: readonly number[];
  readonly concurrency?: number;
  readonly scope?: ValidationScope;
}): Promise<ValidationPlan> {
  const issueContext = new GitHubIssueContext(input.github, input.repo);
  const graph = await loadOpenPrGraph({
    github: input.github,
    repo: input.repo,
    targetBranch: input.targetBranch,
    concurrency: input.concurrency,
    issueContext,
  });
  const scope = input.pullNumbers ? "prs" : (input.scope ?? "prs");
  const pullRequestJobs =
    scope === "issues" ? [] : selectedNodes(graph, input.pullNumbers);
  const issueJobs =
    scope === "prs"
      ? []
      : await issueValidationJobs(
          input.github,
          input.repo,
          graph,
          issueContext,
          input.concurrency
        );

  return {
    graph,
    pullRequestJobs,
    issueJobs,
  };
}

async function issueValidationJobs(
  github: GitHubClient,
  repo: string,
  graph: OpenPrGraph,
  issueContext: GitHubIssueContext,
  concurrency = 4
): Promise<IssueValidationJob[]> {
  const issues = await github.listOpenIssues(repo);
  issueContext.rememberAll(issues);
  const pullRequestsByIssue = openPullRequestsByIssue(graph);

  const withoutOpenPullRequest = issues.filter(
    (issue) => (pullRequestsByIssue.get(issue.number) ?? []).length === 0
  );
  return mapLimit(withoutOpenPullRequest, concurrency, async (issue) => ({
    issue,
    relatedIssues: await issueContext.relatedIssues(issue),
    associatedOpenPullRequests: [],
  }));
}

function selectedNodes(
  graph: OpenPrGraph,
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

function openPullRequestsByIssue(
  graph: OpenPrGraph
): Map<number, PullRequestSummary[]> {
  const prsByIssue = new Map<number, PullRequestSummary[]>();

  for (const node of graph.nodes.values()) {
    for (const ref of node.pr.closingIssuesReferences) {
      const prs = prsByIssue.get(ref.number) ?? [];
      prs.push(summarizePullRequest(node.pr));
      prsByIssue.set(ref.number, prs);
    }
  }

  return prsByIssue;
}

export function summarizePullRequest(pr: PullRequest): PullRequestSummary {
  return {
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
  };
}
