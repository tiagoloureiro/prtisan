import type { AgentRunner } from "@/agent.js";
import { issueRepairBranch, runIdFromDate } from "@/branching.js";
import { createLimiter, mapLimit } from "@/concurrency.js";
import { GitClient } from "@/git.js";
import { GitHubClient } from "@/github.js";
import { loadOpenPrGraph, type OpenPrNode } from "@/open-pr-graph.js";
import { preparePullRequestReview } from "@/review.js";
import type {
  AgentTrainConfig,
  Issue,
  PullRequest,
  ReviewFinding,
} from "@/types.js";

type PullRequestSummary = Pick<
  PullRequest,
  "number" | "url" | "headRefName" | "baseRefName" | "headRefOid"
>;

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
  readonly pr: PullRequestSummary;
  readonly issueNumber?: number;
  readonly status: "validated" | "validation_failed";
  readonly blockingFindings: number;
  readonly advisoryFindings: number;
  readonly repaired: boolean;
  readonly specSkipped: boolean;
  readonly reviewEvent: "COMMENT" | "REQUEST_CHANGES";
}

export interface IssueValidationResult {
  readonly issue: Pick<Issue, "number" | "title" | "url">;
  readonly targetBranch: string;
  readonly status: "validated" | "validation_failed";
  readonly blockingFindings: number;
  readonly advisoryFindings: number;
  readonly associatedOpenPullRequests: readonly PullRequestSummary[];
  readonly commentPosted: boolean;
  readonly repaired: boolean;
  readonly repairPullRequest?: PullRequestSummary;
}

export interface ValidateResult {
  readonly repo: string;
  readonly checkedAt: string;
  readonly pullRequests: readonly PullRequestValidationResult[];
  readonly issues: readonly IssueValidationResult[];
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

  const pullRequestsPromise = mapLimit(
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
  const issuesPromise = input.pullNumbers
    ? Promise.resolve<IssueValidationResult[]>([])
    : validateOpenIssues(input, deps, runId, graph, githubMutate, gitMutate);

  const [pullRequests, issues] = await Promise.all([
    pullRequestsPromise,
    issuesPromise,
  ]);

  return {
    repo: input.config.repo,
    checkedAt,
    pullRequests,
    issues,
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

async function validateOpenIssues(
  input: ValidateInput,
  deps: ValidateDeps,
  runId: string,
  graph: Awaited<ReturnType<typeof loadOpenPrGraph>>,
  githubMutate: <T>(task: () => Promise<T>) => Promise<T>,
  gitMutate: <T>(task: () => Promise<T>) => Promise<T>
): Promise<IssueValidationResult[]> {
  const issues = await deps.github.listOpenIssues(input.config.repo);
  if (issues.length === 0) return [];

  const issueCache = new Map<number, Promise<Issue>>();
  for (const issue of issues) {
    issueCache.set(issue.number, Promise.resolve(issue));
  }

  const getIssue = (issueNumber: number): Promise<Issue> => {
    const cached = issueCache.get(issueNumber);
    if (cached) return cached;
    const promise = deps.github.getIssue(input.config.repo, issueNumber);
    issueCache.set(issueNumber, promise);
    return promise;
  };

  const pullRequestsByIssue = openPullRequestsByIssue(graph);
  await gitMutate(() => deps.git.fetchBranch(input.config.targetBranch));

  return mapLimit(
    issues,
    input.config.concurrency.validate,
    async (issue): Promise<IssueValidationResult> => {
      deps.log?.(
        `Validating ${input.config.targetBranch} against issue #${issue.number}`
      );

      const relatedIssues = await loadRelatedIssues(issue, getIssue);
      const review = await deps.agent.reviewIssueBranch({
        cwd: input.cwd,
        config: input.config,
        runId,
        issue,
        relatedIssues,
        targetBranch: input.config.targetBranch,
      });
      const findings = review.findings;
      const counts = findingCounts(findings);
      const associatedOpenPullRequests =
        pullRequestsByIssue.get(issue.number) ?? [];
      const blockingFindings = findings.filter(
        (finding) => finding.severity === "blocking"
      );
      let repairPullRequest:
        IssueValidationResult["repairPullRequest"] | undefined;
      let repaired = false;

      if (
        (input.repair ?? true) &&
        blockingFindings.length > 0 &&
        associatedOpenPullRequests.length === 0
      ) {
        const branch = issueRepairBranch(issue.number);
        await gitMutate(() =>
          deps.git.prepareBranchFromBase(branch, input.config.targetBranch)
        );
        const outcome = await deps.agent.repairIssueBranch({
          cwd: input.cwd,
          config: input.config,
          runId,
          issue,
          relatedIssues,
          branch,
          targetBranch: input.config.targetBranch,
          findings: blockingFindings,
        });

        if (outcome.commits.length > 0) {
          repaired = true;
          await gitMutate(() => deps.git.pushBranch(branch));
          const pr = await githubMutate(() =>
            deps.github.createOrUpdatePullRequest({
              repo: input.config.repo,
              title: repairPullRequestTitle(issue),
              body: repairPullRequestBody(
                issue,
                input.config.targetBranch,
                blockingFindings
              ),
              baseBranch: input.config.targetBranch,
              headBranch: branch,
            })
          );
          repairPullRequest = summarizePullRequest(pr);
        }
      }

      await githubMutate(() =>
        deps.github.createIssueComment(
          input.config.repo,
          issue.number,
          issueValidationComment({
            issue,
            targetBranch: input.config.targetBranch,
            findings,
            associatedOpenPullRequests,
            repairEnabled: input.repair ?? true,
            repaired,
            repairPullRequest,
          })
        )
      );

      return {
        issue: {
          number: issue.number,
          title: issue.title,
          url: issue.url,
        },
        targetBranch: input.config.targetBranch,
        status:
          counts.blockingFindings === 0 ? "validated" : "validation_failed",
        blockingFindings: counts.blockingFindings,
        advisoryFindings: counts.advisoryFindings,
        associatedOpenPullRequests,
        commentPosted: true,
        repaired,
        repairPullRequest,
      };
    }
  );
}

async function loadRelatedIssues(
  issue: Issue,
  getIssue: (issueNumber: number) => Promise<Issue>
): Promise<Issue[]> {
  const numbers = new Set<number>();
  for (const ref of [
    ...issue.blockedBy,
    ...issue.blocking,
    ...issue.subIssues,
  ]) {
    numbers.add(ref.number);
  }
  if (issue.parent) numbers.add(issue.parent.number);
  numbers.delete(issue.number);
  return Promise.all([...numbers].map((issueNumber) => getIssue(issueNumber)));
}

function openPullRequestsByIssue(
  graph: Awaited<ReturnType<typeof loadOpenPrGraph>>
): Map<number, IssueValidationResult["associatedOpenPullRequests"]> {
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

function summarizePullRequest(pr: PullRequest): PullRequestSummary {
  return {
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
  };
}

function findingCounts(findings: readonly ReviewFinding[]): {
  readonly blockingFindings: number;
  readonly advisoryFindings: number;
} {
  const blockingFindings = findings.filter(
    (finding) => finding.severity === "blocking"
  ).length;
  return {
    blockingFindings,
    advisoryFindings: findings.length - blockingFindings,
  };
}

function repairPullRequestTitle(issue: Issue): string {
  return `Repair issue #${issue.number}: ${issue.title}`;
}

function repairPullRequestBody(
  issue: Issue,
  targetBranch: string,
  blockingFindings: readonly ReviewFinding[]
): string {
  return [
    `Closes #${issue.number}`,
    "",
    "<!-- agent-train:repair-pr -->",
    "",
    "## Agent Train Repair",
    "",
    `This PR was created after validating \`${targetBranch}\` against issue #${issue.number}.`,
    "",
    "Blocking findings addressed:",
    ...blockingFindings.map((finding) => `- ${finding.title}`),
  ].join("\n");
}

function issueValidationComment(input: {
  readonly issue: Issue;
  readonly targetBranch: string;
  readonly findings: readonly ReviewFinding[];
  readonly associatedOpenPullRequests: IssueValidationResult["associatedOpenPullRequests"];
  readonly repairEnabled: boolean;
  readonly repaired: boolean;
  readonly repairPullRequest?: IssueValidationResult["repairPullRequest"];
}): string {
  const counts = findingCounts(input.findings);
  const status =
    counts.blockingFindings === 0 ? "validated" : "validation_failed";
  const lines = [
    `<!-- agent-train:main-validation ${JSON.stringify({
      targetBranch: input.targetBranch,
      blockingFindings: counts.blockingFindings,
      advisoryFindings: counts.advisoryFindings,
    })} -->`,
    "",
    `Agent train validated \`${input.targetBranch}\` against issue #${input.issue.number}.`,
    "",
    `Status: ${status}`,
    `Blocking findings: ${counts.blockingFindings}`,
    `Advisory findings: ${counts.advisoryFindings}`,
    "",
    issueValidationOutcome(input, counts.blockingFindings),
  ];

  if (input.findings.length > 0) {
    lines.push("", "Findings:", ...input.findings.map(issueFindingLine));
  }

  return lines.join("\n");
}

function issueValidationOutcome(
  input: {
    readonly associatedOpenPullRequests: IssueValidationResult["associatedOpenPullRequests"];
    readonly repairEnabled: boolean;
    readonly repaired: boolean;
    readonly repairPullRequest?: IssueValidationResult["repairPullRequest"];
  },
  blockingFindings: number
): string {
  if (blockingFindings === 0) {
    return "The target branch currently satisfies this issue.";
  }

  if (input.associatedOpenPullRequests.length > 0) {
    return `Blocking gaps remain on the target branch. Existing open PR(s): ${input.associatedOpenPullRequests.map(pullRequestMarkdownLink).join(", ")}. No duplicate repair PR was created.`;
  }

  if (input.repairPullRequest) {
    return `Blocking gaps remain on the target branch. Created or updated repair PR: ${pullRequestMarkdownLink(input.repairPullRequest)}.`;
  }

  if (!input.repairEnabled) {
    return "Blocking gaps remain on the target branch. Repair is disabled for this validation run.";
  }

  if (!input.repaired) {
    return "Blocking gaps remain on the target branch. The repair agent did not commit changes, so no repair PR was created.";
  }

  return "Blocking gaps remain on the target branch.";
}

function issueFindingLine(finding: ReviewFinding): string {
  const location = finding.path
    ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})`
    : "";
  return `- **${finding.severity} ${finding.axis}: ${finding.title}**${location}\n  ${finding.body}`;
}

function pullRequestMarkdownLink(
  pr: Pick<PullRequest, "number" | "url">
): string {
  return pr.url ? `[#${pr.number}](${pr.url})` : `#${pr.number}`;
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
