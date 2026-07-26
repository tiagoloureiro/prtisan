import type { AgentRunner } from "@/agent.js";
import { issueRepairBranch, runIdFromDate } from "@/branching.js";
import { createLimiter, mapLimit } from "@/concurrency.js";
import { GitClient } from "@/git.js";
import { GitHubClient } from "@/github.js";
import type { ReviewCache } from "@/review-cache.js";
import { writeRunRecord } from "@/run-record.js";
import type { RuntimeProvider, VerificationRunner } from "@/runtime.js";
import type {
  AgentTrainConfig,
  Issue,
  PullRequest,
  ReviewFinding,
  ValidationOutcome,
  ValidationScope,
} from "@/types.js";
import {
  buildValidationPlan,
  type IssueValidationJob,
  type PullRequestSummary,
  summarizePullRequest,
} from "@/validation-context.js";
import {
  ValidationCoordinator,
  type ValidationCoordinatorDeps,
} from "@/validation-coordinator.js";
import { normalizeAndDedupeFindings } from "@/validation-hardening.js";
import type { ValidationLease } from "@/validation-lease.js";

export interface ValidateInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly pullNumbers?: readonly number[];
  readonly repair?: boolean;
  readonly runId?: string;
  readonly scope?: ValidationScope;
}

export interface ValidateDeps {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly agent: AgentRunner;
  readonly runtime: RuntimeProvider;
  readonly verification: VerificationRunner;
  readonly cache?: ReviewCache;
  readonly lease?: {
    acquire(
      key: string,
      options: { readonly waitMs: number }
    ): Promise<ValidationLease>;
  };
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
  readonly outcome: ValidationOutcome;
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
  const startedAt = new Date().toISOString();
  try {
    const result = await executeValidateRun(input, deps, runId);
    await writeRunRecord(input.cwd, {
      schemaVersion: 1,
      runId,
      command: "validate",
      repo: input.config.repo,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "completed",
      result,
    }).catch(() => undefined);
    return result;
  } catch (error) {
    await writeRunRecord(input.cwd, {
      schemaVersion: 1,
      runId,
      command: "validate",
      repo: input.config.repo,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

async function executeValidateRun(
  input: ValidateInput,
  deps: ValidateDeps,
  runId: string
): Promise<ValidateResult> {
  const plan = await buildValidationPlan({
    github: deps.github,
    repo: input.config.repo,
    targetBranch: input.config.targetBranch,
    pullNumbers: input.pullNumbers,
    concurrency: input.config.concurrency.github,
    scope: input.scope,
  });
  const githubMutate = createLimiter(input.config.concurrency.github);
  const gitMutate = createLimiter(1);
  const checkedAt = new Date().toISOString();
  const coordinator = new ValidationCoordinator({
    github: deps.github,
    git: deps.git,
    agent: deps.agent,
    runtime: deps.runtime,
    verification: deps.verification,
    cache: deps.cache,
    lease: deps.lease,
    githubMutate,
    gitMutate,
    log: deps.log,
  } satisfies ValidationCoordinatorDeps);

  const pullRequestsPromise = mapLimit(
    plan.pullRequestJobs,
    input.config.concurrency.validate,
    async (node): Promise<PullRequestValidationResult> => {
      deps.log?.(
        node.issue
          ? `Validating PR #${node.pr.number} for issue #${node.issue.number}`
          : `Validating PR #${node.pr.number} with Standards only`
      );

      const coordinated = await coordinator.validate({
        cwd: input.cwd,
        config: input.config,
        runId,
        prNumber: node.pr.number,
        issue: node.issue,
        relatedIssues: node.relatedIssues,
        repair: input.repair ?? true,
      });
      const blockingCount = coordinated.findings.filter(
        (finding) => finding.severity === "blocking"
      ).length;
      const advisoryCount = coordinated.findings.length - blockingCount;
      const pr = coordinated.pr;
      return {
        pr: {
          number: pr.number,
          url: pr.url,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          headRefOid: pr.headRefOid,
        },
        issueNumber: node.issue?.number,
        status:
          coordinated.outcome.kind === "passed" ||
          coordinated.outcome.kind === "repaired"
            ? "validated"
            : "validation_failed",
        blockingFindings: blockingCount,
        advisoryFindings: advisoryCount,
        repaired: coordinated.repaired,
        specSkipped: coordinated.specSkipped,
        reviewEvent: coordinated.reviewEvent,
        outcome: coordinated.outcome,
      };
    }
  );
  const issuesPromise =
    input.pullNumbers || (input.scope ?? "prs") === "prs"
      ? Promise.resolve<IssueValidationResult[]>([])
      : validateOpenIssues(
          input,
          deps,
          runId,
          plan.issueJobs,
          githubMutate,
          gitMutate
        );

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

async function validateOpenIssues(
  input: ValidateInput,
  deps: ValidateDeps,
  runId: string,
  issueJobs: readonly IssueValidationJob[],
  githubMutate: <T>(task: () => Promise<T>) => Promise<T>,
  gitMutate: <T>(task: () => Promise<T>) => Promise<T>
): Promise<IssueValidationResult[]> {
  if (issueJobs.length === 0) return [];

  await gitMutate(() => deps.git.fetchBranch(input.config.targetBranch));
  const targetHead = await gitMutate(() =>
    deps.git.revParseRemoteBranch(input.config.targetBranch)
  );
  const runtime = await deps.runtime.prepare({
    cwd: input.cwd,
    ref: targetHead,
    config: input.config,
  });

  return mapLimit(
    issueJobs,
    input.config.concurrency.validate,
    async (job): Promise<IssueValidationResult> => {
      const { issue, relatedIssues, associatedOpenPullRequests } = job;
      deps.log?.(
        `Validating ${input.config.targetBranch} against issue #${issue.number}`
      );
      await assertTargetBranchFresh(
        deps,
        input.config.targetBranch,
        targetHead,
        gitMutate
      );

      const review = await deps.agent.review({
        kind: "issue-branch",
        cwd: input.cwd,
        config: input.config,
        runId,
        issue,
        relatedIssues,
        targetBranch: input.config.targetBranch,
        runtime,
      });
      const findings = normalizeAndDedupeFindings(review.findings);
      await assertTargetBranchFresh(
        deps,
        input.config.targetBranch,
        targetHead,
        gitMutate
      );
      const counts = findingCounts(findings);
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
        const remoteBranchExists = await gitMutate(() =>
          deps.git.branchExistsOnRemote(branch)
        );
        const expectedRemoteHead = remoteBranchExists
          ? await gitMutate(() => deps.git.revParseRemoteBranch(branch))
          : "";
        await gitMutate(() =>
          deps.git.prepareBranchAt(branch, expectedRemoteHead || targetHead)
        );
        try {
          const outcome = await deps.agent.repair({
            kind: "issue-branch",
            cwd: input.cwd,
            config: input.config,
            runId,
            issue,
            relatedIssues,
            branch,
            targetBranch: input.config.targetBranch,
            findings: blockingFindings,
            runtime,
          });

          const repairedCommit = outcome.commits.at(-1);
          if (
            repairedCommit &&
            validIssueRepairContract(outcome.structuredOutput, blockingFindings)
          ) {
            const repairedRuntime = await deps.runtime.prepare({
              cwd: input.cwd,
              ref: repairedCommit,
              config: input.config,
            });
            const verification = await deps.verification.verify({
              cwd: input.cwd,
              runId,
              label: `issue-${issue.number}`,
              ref: repairedCommit,
              config: input.config,
              runtime: repairedRuntime,
            });
            await assertTargetBranchFresh(
              deps,
              input.config.targetBranch,
              targetHead,
              gitMutate
            );
            if (verification.status !== "passed") {
              throw new Error(
                `Issue #${issue.number} repair failed host verification (${verification.status}); nothing was pushed.`
              );
            }
            await gitMutate(() =>
              deps.git.pushVerifiedCommit({
                branch,
                commit: repairedCommit,
                expectedRemoteSha: expectedRemoteHead,
              })
            );
            repaired = true;
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
          } else if (repairedCommit) {
            throw new Error(
              `Issue #${issue.number} repair did not return a complete structured repair report; nothing was pushed.`
            );
          }
        } finally {
          await gitMutate(() => deps.git.deleteLocalBranch(branch));
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

async function assertTargetBranchFresh(
  deps: Pick<ValidateDeps, "git">,
  targetBranch: string,
  expectedHead: string,
  gitMutate: <T>(task: () => Promise<T>) => Promise<T>
): Promise<void> {
  const currentHead = await gitMutate(() =>
    deps.git.revParseRemoteBranch(targetBranch)
  );
  if (currentHead !== expectedHead) {
    throw new Error(
      `Target branch ${targetBranch} changed during issue validation; no comment or repair was published.`
    );
  }
}

function validIssueRepairContract(
  value: unknown,
  findings: readonly ReviewFinding[]
): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const addressed = new Set(
    Array.isArray(record.addressedFindingIds)
      ? record.addressedFindingIds.filter(
          (id): id is string => typeof id === "string"
        )
      : []
  );
  const changedPaths = record.changedPaths;
  return (
    findings.every(
      (finding) =>
        Boolean(finding.findingId) && addressed.has(finding.findingId as string)
    ) &&
    Array.isArray(changedPaths) &&
    changedPaths.every((path) => typeof path === "string")
  );
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
