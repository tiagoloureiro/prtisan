import type { AgentRunner } from "@/agent.js";
import { createLimiter, mapLimit } from "@/concurrency.js";
import type { GitClient } from "@/git.js";
import type { GitHubClient } from "@/github.js";
import { loadOpenPrGraph } from "@/open-pr-graph.js";
import type { ReviewCache } from "@/review-cache.js";
import type { RuntimeProvider, VerificationRunner } from "@/runtime.js";
import type { AgentTrainConfig, Issue, ValidationOutcome } from "@/types.js";
import type { PullRequestSummary } from "@/validation-context.js";
import {
  ValidationCoordinator,
  type ValidationCoordinatorDeps,
} from "@/validation-coordinator.js";
import type { ValidationLease } from "@/validation-lease.js";

export interface ValidateInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly pullNumbers: readonly number[];
  readonly repair?: boolean;
  readonly runId: string;
  readonly contractOverrides?: Readonly<Record<number, Issue>>;
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

export interface ValidateResult {
  readonly repo: string;
  readonly checkedAt: string;
  readonly pullRequests: readonly PullRequestValidationResult[];
}

export async function executeValidate(
  input: ValidateInput,
  deps: ValidateDeps
): Promise<ValidateResult> {
  if (input.pullNumbers.length === 0) {
    throw new Error("Selected-PR validation requires at least one PR number.");
  }
  const graph = await loadOpenPrGraph({
    github: deps.github,
    repo: input.config.repo,
    targetBranch: input.config.targetBranch,
    concurrency: input.config.concurrency.github,
  });
  const selected = input.pullNumbers.map((number) => {
    const node = graph.nodes.get(number);
    if (!node) throw new Error(`PR #${number} is not in the open train.`);
    return node;
  });
  const coordinator = new ValidationCoordinator({
    github: deps.github,
    git: deps.git,
    agent: deps.agent,
    runtime: deps.runtime,
    verification: deps.verification,
    cache: deps.cache,
    lease: deps.lease,
    githubMutate: createLimiter(input.config.concurrency.github),
    gitMutate: createLimiter(1),
    log: deps.log,
  } satisfies ValidationCoordinatorDeps);

  const pullRequests = await mapLimit(
    selected,
    input.config.concurrency.validate,
    async (node): Promise<PullRequestValidationResult> => {
      const contract = input.contractOverrides?.[node.pr.number] ?? node.issue;
      deps.log?.(
        contract
          ? `Validating PR #${node.pr.number} against its frozen intent contract`
          : `Validating PR #${node.pr.number} against repository policy`
      );
      const coordinated = await coordinator.validate({
        cwd: input.cwd,
        config: input.config,
        runId: input.runId,
        prNumber: node.pr.number,
        issue: contract,
        relatedIssues: node.relatedIssues,
        repair: input.repair ?? true,
      });
      const blockingFindings = coordinated.findings.filter(
        (finding) => finding.severity === "blocking"
      ).length;
      const pr = coordinated.pr;
      return {
        pr: {
          number: pr.number,
          url: pr.url,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          headRefOid: pr.headRefOid,
        },
        issueNumber: contract?.number,
        status:
          coordinated.outcome.kind === "passed" ||
          coordinated.outcome.kind === "repaired"
            ? "validated"
            : "validation_failed",
        blockingFindings,
        advisoryFindings: coordinated.findings.length - blockingFindings,
        repaired: coordinated.repaired,
        specSkipped: coordinated.specSkipped,
        reviewEvent: coordinated.reviewEvent,
        outcome: coordinated.outcome,
      };
    }
  );

  return {
    repo: input.config.repo,
    checkedAt: new Date().toISOString(),
    pullRequests,
  };
}
