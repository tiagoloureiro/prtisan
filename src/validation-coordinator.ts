import {
  AgentAuthenticationError,
  AgentExecutionError,
  AgentInfrastructureError,
  AgentOutputError,
  AgentPromptBudgetError,
  type AgentRunner,
} from "./agent.js";
import type { GitClient } from "./git.js";
import { type GitHubClient, managedCommentSection } from "./github.js";
import { validationStatusFromPr } from "./open-pr-graph.js";
import {
  preparePullRequestReview,
  type ValidationReviewMetadata,
} from "./review.js";
import {
  InMemoryReviewCache,
  type ReviewCache,
  reviewCacheKey,
} from "./review-cache.js";
import {
  type PreparedRuntime,
  RuntimePreparationError,
  type RuntimeProvider,
  type VerificationRunner,
} from "./runtime.js";
import type {
  AgentTrainConfig,
  Issue,
  PullRequest,
  RepairVerificationReport,
  ReviewAxis,
  ReviewFinding,
  ReviewReport,
  ValidationMetrics,
  ValidationOutcome,
  VerificationResult,
} from "./types.js";
import {
  buildValidationSnapshot,
  changedFilesFromDiff,
  normalizeAndDedupeFindings,
  stableDigest,
  validationIssueContextDigest,
  type ValidationSnapshot,
} from "./validation-hardening.js";
import { singleFlight, type ValidationLease } from "./validation-lease.js";

const REVIEW_SCHEMA_VERSION = 2;
const REVIEW_PROMPT_SCHEMA_DIGEST = stableDigest({
  schemaVersion: REVIEW_SCHEMA_VERSION,
  rawDiff: false,
  relatedIssues: "metadata",
  findingFields: [
    "axis",
    "severity",
    "title",
    "body",
    "rule",
    "evidence",
    "path",
    "line",
    "side",
  ],
});
const POST_REPAIR_HEAD_REFRESH_ATTEMPTS = 10;
const POST_REPAIR_HEAD_REFRESH_INTERVAL_MS = 2_000;

export interface ValidationRequest {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runId: string;
  readonly prNumber: number;
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly repair: boolean;
  readonly remainingRepairRounds?: number;
  readonly repairRound?: number;
}

export interface CoordinatedValidationResult {
  readonly pr: PullRequest;
  readonly findings: readonly ReviewFinding[];
  readonly repaired: boolean;
  readonly specSkipped: boolean;
  readonly reviewEvent: "COMMENT" | "REQUEST_CHANGES";
  readonly outcome: ValidationOutcome;
}

export interface ValidationCoordinatorDeps {
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
  readonly githubMutate?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly gitMutate?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly log?: (message: string) => void;
}

export class ValidationCoordinator {
  private readonly cache: ReviewCache;
  private readonly githubMutate: <T>(task: () => Promise<T>) => Promise<T>;
  private readonly gitMutate: <T>(task: () => Promise<T>) => Promise<T>;

  constructor(private readonly deps: ValidationCoordinatorDeps) {
    this.cache = deps.cache ?? new InMemoryReviewCache();
    this.githubMutate = deps.githubMutate ?? ((task) => task());
    this.gitMutate = deps.gitMutate ?? ((task) => task());
  }

  async validate(
    request: ValidationRequest
  ): Promise<CoordinatedValidationResult> {
    const metrics = new Metrics(request.config.validation.maxWallTimeMs);
    let pr = await metrics.stage("load-pr", () =>
      this.deps.github.getPullRequest(request.config.repo, request.prNumber)
    );
    await this.gitMutate(() =>
      this.deps.git.prepareBranchFromBase(pr.headRefName, pr.baseRefName)
    );
    const diff = await metrics.stage("load-diff", () =>
      this.deps.github.getPullRequestDiff(request.config.repo, pr.number)
    );
    const changedFiles = changedFilesFromDiff(diff);
    const standardsContents =
      typeof this.deps.git.readStandardsAtRef === "function"
        ? await metrics.stage("standards-context", () =>
            this.deps.git.readStandardsAtRef(pr.baseRefOid, changedFiles)
          )
        : [];

    let runtime: PreparedRuntime;
    try {
      runtime = await metrics.stage("runtime", () =>
        this.deps.runtime.prepare({
          cwd: request.cwd,
          ref: pr.headRefOid,
          config: metrics.budgetedConfig(request.config),
        })
      );
    } catch (error) {
      return failureResult({
        pr,
        specSkipped: !request.issue,
        outcome: {
          kind: "infra_failed",
          snapshotKey: provisionalSnapshotKey(pr, error),
          reason: errorMessage(error),
          metrics: metrics.finish(),
        },
      });
    }

    const snapshot = buildValidationSnapshot({
      pr,
      diff,
      issue: request.issue,
      relatedIssues: request.relatedIssues,
      standardsContents,
      runtimeFingerprint: runtime.fingerprint,
      config: request.config,
    });
    const leaseKey = `${request.config.repo}:${pr.number}:${snapshot.key}`;
    const flightKey = `${leaseKey}:repair=${request.repair ? "enabled" : "disabled"}`;

    return singleFlight(flightKey, async () => {
      const lease = this.deps.lease
        ? await this.deps.lease.acquire(leaseKey, {
            waitMs: request.config.validation.maxWallTimeMs,
          })
        : undefined;
      try {
        pr = await this.assertFreshOrThrow(request, snapshot);
        const existing = validationStatusFromPr(pr);
        if (
          existing.snapshotKey === snapshot.key &&
          (existing.state === "passed" || existing.state === "commented")
        ) {
          metrics.cacheHit();
          return {
            pr,
            findings: [],
            repaired: existing.outcome === "repaired",
            specSkipped: !request.issue,
            reviewEvent: existing.reviewEvent ?? "COMMENT",
            outcome: {
              kind: existing.outcome === "repaired" ? "repaired" : "passed",
              snapshotKey: snapshot.key,
              metrics: metrics.finish(),
            },
          };
        }
        if (
          existing.snapshotKey === snapshot.key &&
          existing.state === "needs_human"
        ) {
          metrics.cacheHit();
          return failureResult({
            pr,
            specSkipped: !request.issue,
            outcome: {
              kind: "needs_human",
              snapshotKey: snapshot.key,
              reason:
                "This snapshot already exhausted its single repair batch and requires human intervention.",
              findings: [],
              metrics: metrics.finish(),
            },
          });
        }

        const reports = await metrics.stage("review", () =>
          this.collectReports(request, pr, snapshot, runtime, metrics)
        );
        const findings = authorizeFindings(
          normalizeAndDedupeFindings(
            reports.flatMap((report) => report.findings)
          )
        );
        pr = await this.assertFreshOrThrow(request, snapshot);
        const blockers = findings.filter(
          (finding) => finding.severity === "blocking"
        );

        if (blockers.length === 0) {
          const markerOutcome = {
            kind: "passed",
            snapshotKey: snapshot.key,
            metrics: metrics.finish(),
          } satisfies ValidationOutcome;
          const reviewEvent = await metrics.stage("publication", () =>
            this.publishReview(
              request,
              pr,
              diff,
              findings,
              snapshot,
              markerOutcome
            )
          );
          const outcome = {
            ...markerOutcome,
            metrics: metrics.finish(),
          };
          return {
            pr,
            findings,
            repaired: false,
            specSkipped: !request.issue,
            reviewEvent,
            outcome,
          };
        }

        const remainingRepairRounds =
          request.remainingRepairRounds ??
          request.config.validation.maxRepairRounds;
        if (!request.repair || remainingRepairRounds === 0) {
          const markerOutcome = {
            kind: "blocked",
            snapshotKey: snapshot.key,
            reason: `${blockers.length} blocking finding(s) remain and repair is disabled.`,
            findings,
            metrics: metrics.finish(),
          } satisfies ValidationOutcome;
          const reviewEvent = await metrics.stage("publication", () =>
            this.publishReview(
              request,
              pr,
              diff,
              findings,
              snapshot,
              markerOutcome
            )
          );
          const outcome = {
            ...markerOutcome,
            metrics: metrics.finish(),
          };
          return {
            pr,
            findings,
            repaired: false,
            specSkipped: !request.issue,
            reviewEvent,
            outcome,
          };
        }

        return await this.repairAndValidate({
          request: {
            ...request,
            remainingRepairRounds,
            repairRound: request.repairRound ?? 1,
          },
          pr,
          diff,
          snapshot,
          runtime,
          findings,
          blockers,
          metrics,
        });
      } catch (error) {
        if (error instanceof AgentAuthenticationError) {
          throw error;
        }
        if (error instanceof StaleSnapshotError) {
          return failureResult({
            pr: error.pr,
            specSkipped: !request.issue,
            outcome: {
              kind: "stale",
              snapshotKey: snapshot.key,
              reason: error.message,
              metrics: metrics.finish(),
            },
          });
        }
        if (error instanceof AgentBudgetError) {
          return failureResult({
            pr,
            specSkipped: !request.issue,
            outcome: {
              kind: "budget_exhausted",
              snapshotKey: snapshot.key,
              reason: error.message,
              metrics: metrics.finish(),
            },
          });
        }
        if (error instanceof AgentPromptBudgetError) {
          return failureResult({
            pr,
            specSkipped: !request.issue,
            outcome: {
              kind: "budget_exhausted",
              snapshotKey: snapshot.key,
              reason: error.message,
              metrics: metrics.finish(),
            },
          });
        }
        if (error instanceof AgentInfrastructureError) {
          return failureResult({
            pr,
            specSkipped: !request.issue,
            outcome: {
              kind: "infra_failed",
              snapshotKey: snapshot.key,
              reason: error.message,
              metrics: metrics.finish(),
            },
          });
        }
        if (error instanceof AgentOutputError) {
          metrics.failedAgent();
          return failureResult({
            pr,
            specSkipped: !request.issue,
            outcome: needsHuman(snapshot.key, error.message, [], metrics),
          });
        }
        if (error instanceof AgentExecutionError) {
          metrics.failedAgent();
          return failureResult({
            pr,
            specSkipped: !request.issue,
            outcome: needsHuman(snapshot.key, error.message, [], metrics),
          });
        }
        if (error instanceof RuntimePreparationError) {
          return failureResult({
            pr,
            specSkipped: !request.issue,
            outcome: {
              kind: "infra_failed",
              snapshotKey: snapshot.key,
              reason: error.message,
              metrics: metrics.finish(),
            },
          });
        }
        throw error;
      } finally {
        await lease?.release();
      }
    });
  }

  private async collectReports(
    request: ValidationRequest,
    pr: PullRequest,
    snapshot: ValidationSnapshot,
    runtime: PreparedRuntime,
    metrics: Metrics
  ): Promise<ReviewReport[]> {
    const standards = this.reviewAxis(
      request,
      pr,
      snapshot,
      runtime,
      metrics,
      "standards"
    );
    return request.issue
      ? Promise.all([
          standards,
          this.reviewAxis(request, pr, snapshot, runtime, metrics, "spec"),
        ])
      : [await standards];
  }

  private async reviewAxis(
    request: ValidationRequest,
    pr: PullRequest,
    snapshot: ValidationSnapshot,
    runtime: PreparedRuntime,
    metrics: Metrics,
    axis: ReviewAxis
  ): Promise<ReviewReport> {
    const role = axis === "standards" ? "standardsReview" : "specReview";
    const profile = request.config.agentProfiles[role];
    const key = reviewCacheKey({
      snapshotKey: snapshot.key,
      axis,
      role,
      profile,
      promptSchemaDigest: REVIEW_PROMPT_SCHEMA_DIGEST,
    });
    return singleFlight(`review:${key}`, async () => {
      const cached = await this.cache.get(key);
      if (cached) {
        metrics.cacheHit();
        return cached;
      }

      metrics.beforeAgent(request.config);
      const report = await this.deps.agent.review({
        kind: "pull-request",
        cwd: request.cwd,
        config: metrics.budgetedConfig(request.config),
        runId: request.runId,
        issue: request.issue,
        relatedIssues: request.relatedIssues,
        prNumber: pr.number,
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        baseRefOid: pr.baseRefOid,
        headRefOid: pr.headRefOid,
        changedFiles: snapshot.changedFiles,
        diff: "",
        axis,
        runtime,
      });
      metrics.afterAgent(report);
      const normalized = {
        axis: report.axis,
        summary: report.summary,
        promptChars: report.promptChars,
        durationMs: report.durationMs,
        findings: normalizeAndDedupeFindings(report.findings),
      };
      await this.cache.set(key, normalized);
      return normalized;
    });
  }

  private async repairAndValidate(input: {
    readonly request: ValidationRequest;
    readonly pr: PullRequest;
    readonly diff: string;
    readonly snapshot: ValidationSnapshot;
    readonly runtime: PreparedRuntime;
    readonly findings: readonly ReviewFinding[];
    readonly blockers: readonly ReviewFinding[];
    readonly metrics: Metrics;
  }): Promise<CoordinatedValidationResult> {
    const { request, runtime, metrics } = input;
    let pr = input.pr;
    const repairBranch = `prtisan/repair/pr-${pr.number}-${safeRunId(
      request.runId
    )}-r${request.repairRound ?? 1}`;
    await this.gitMutate(() =>
      this.deps.git.prepareBranchAt(repairBranch, pr.headRefOid)
    );

    try {
      metrics.beforeAgent(request.config);
      const repair = await metrics.stage("repair", () =>
        this.deps.agent.repair({
          kind: "pull-request",
          cwd: request.cwd,
          config: metrics.budgetedConfig(request.config),
          runId: request.runId,
          issue: request.issue,
          relatedIssues: request.relatedIssues,
          prNumber: pr.number,
          branch: repairBranch,
          baseBranch: pr.headRefName,
          findings: input.blockers,
          runtime,
        })
      );
      metrics.afterAgent(repair);
      const repairedCommit = repair.commits.at(-1);
      if (!repairedCommit) {
        return this.publishNeedsHuman({
          request,
          pr,
          diff: input.diff,
          snapshot: input.snapshot,
          findings: input.findings,
          reason: "The repair agent produced no commit.",
          metrics,
        });
      }
      if (repairedCommit === pr.headRefOid) {
        return this.publishNeedsHuman({
          request,
          pr,
          diff: input.diff,
          snapshot: input.snapshot,
          findings: input.findings,
          reason:
            "The repair agent did not advance the candidate head; bounded convergence stopped to avoid repeating the same repair.",
          metrics,
        });
      }
      const repairContractError = validateRepairContract(
        repair.structuredOutput,
        input.blockers
      );
      if (repairContractError) {
        return this.publishNeedsHuman({
          request,
          pr,
          diff: input.diff,
          snapshot: input.snapshot,
          findings: input.findings,
          reason: repairContractError,
          metrics,
        });
      }

      let repairedRuntime: PreparedRuntime;
      try {
        repairedRuntime = await metrics.stage("repair-runtime", () =>
          this.deps.runtime.prepare({
            cwd: request.cwd,
            ref: repairedCommit,
            config: metrics.budgetedConfig(request.config),
          })
        );
      } catch (error) {
        return failureResult({
          pr,
          findings: input.findings,
          specSkipped: !request.issue,
          outcome: {
            kind: "infra_failed",
            snapshotKey: input.snapshot.key,
            reason: errorMessage(error),
            metrics: metrics.finish(),
          },
        });
      }
      const verification = await metrics.stage("verification", () =>
        this.deps.verification.verify({
          cwd: request.cwd,
          runId: request.runId,
          label: `pr-${pr.number}`,
          ref: repairedCommit,
          config: metrics.budgetedConfig(request.config),
          runtime: repairedRuntime,
        })
      );
      if (verification.status !== "passed") {
        const kind =
          verification.status === "infra_failed" ? "infra_failed" : "blocked";
        return failureResult({
          pr,
          findings: input.findings,
          specSkipped: !request.issue,
          outcome:
            kind === "infra_failed"
              ? {
                  kind,
                  snapshotKey: input.snapshot.key,
                  reason: verificationFailureReason(verification),
                  verification,
                  metrics: metrics.finish(),
                }
              : {
                  kind,
                  snapshotKey: input.snapshot.key,
                  reason: verificationFailureReason(verification),
                  findings: input.findings,
                  verification,
                  metrics: metrics.finish(),
                },
        });
      }
      metrics.assertWithinBudget();

      if (!this.deps.agent.verifyRepair) {
        return this.publishNeedsHuman({
          request,
          pr,
          diff: input.diff,
          snapshot: input.snapshot,
          findings: input.findings,
          reason:
            "The configured agent adapter cannot perform targeted repair verification.",
          metrics,
          verification,
        });
      }

      metrics.beforeAgent(request.config);
      const repairVerification = await metrics.stage(
        "repair-review",
        async () =>
          this.deps.agent.verifyRepair!({
            cwd: request.cwd,
            config: metrics.budgetedConfig(request.config),
            runId: request.runId,
            issue: request.issue,
            relatedIssues: request.relatedIssues,
            prNumber: pr.number,
            branch: repairBranch,
            baseBranch: pr.headRefName,
            baseRefOid: pr.headRefOid,
            repairedHeadRefOid: repairedCommit,
            findings: input.blockers,
            runtime: repairedRuntime,
          })
      );
      metrics.afterAgent(repairVerification);
      const targetedFindings = normalizeAndDedupeFindings(
        repairVerification.findings
      );
      const unresolved = unresolvedFindingIds(
        input.blockers,
        repairVerification,
        targetedFindings
      );
      if (
        unresolved.length > 0 ||
        targetedFindings.some((finding) => finding.severity === "blocking")
      ) {
        const remaining = normalizeAndDedupeFindings([
          ...input.findings.filter(
            (finding) =>
              finding.severity !== "blocking" ||
              unresolved.includes(finding.findingId ?? "")
          ),
          ...targetedFindings,
        ]);
        return this.publishNeedsHuman({
          request,
          pr,
          diff: input.diff,
          snapshot: input.snapshot,
          findings: remaining,
          reason:
            "Blocking findings survived the single repair batch or the repair introduced a new blocker.",
          metrics,
          verification,
        });
      }

      pr = await this.assertFreshOrThrow(request, input.snapshot);
      metrics.assertWithinBudget();
      await metrics.stage("push", () =>
        this.gitMutate(() =>
          this.deps.git.pushAdditiveCommit({
            branch: pr.headRefName,
            commit: repairedCommit,
            expectedRemoteSha: pr.headRefOid,
          })
        )
      );
      pr = await metrics.stage("refresh-repaired-head", () =>
        waitForPullRequestHead(
          this.deps.github,
          request.config.repo,
          pr.number,
          repairedCommit
        )
      );
      this.deps.log?.(
        `Re-reviewing PR #${pr.number} after repair round ${request.repairRound ?? 1}`
      );
      const followUp = await this.validate({
        ...request,
        remainingRepairRounds: Math.max(
          0,
          (request.remainingRepairRounds ?? 1) - 1
        ),
        repairRound: (request.repairRound ?? 1) + 1,
      });
      return {
        ...followUp,
        repaired: true,
        outcome:
          followUp.outcome.kind === "passed"
            ? { ...followUp.outcome, kind: "repaired" as const }
            : followUp.outcome,
      };
    } finally {
      await this.gitMutate(() => this.deps.git.deleteLocalBranch(repairBranch));
    }
  }

  private async assertFreshOrThrow(
    request: ValidationRequest,
    snapshot: Pick<
      ValidationSnapshot,
      "headRefOid" | "baseRefOid" | "issueContextDigest"
    >
  ): Promise<PullRequest> {
    const current = await this.deps.github.getPullRequest(
      request.config.repo,
      request.prNumber
    );
    if (
      current.headRefOid !== snapshot.headRefOid ||
      current.baseRefOid !== snapshot.baseRefOid
    ) {
      throw new StaleSnapshotError(
        current,
        `PR #${current.number} changed during validation (${shortSha(
          snapshot.baseRefOid
        )}..${shortSha(snapshot.headRefOid)} -> ${shortSha(
          current.baseRefOid
        )}..${shortSha(current.headRefOid)}).`
      );
    }
    if (request.issue) {
      const [currentIssue, ...currentRelated] = await Promise.all([
        this.deps.github.getIssue(request.config.repo, request.issue.number),
        ...request.relatedIssues.map((issue) =>
          this.deps.github.getIssue(request.config.repo, issue.number)
        ),
      ]);
      if (
        validationIssueContextDigest(currentIssue, currentRelated) !==
        snapshot.issueContextDigest
      ) {
        throw new StaleSnapshotError(
          current,
          `Issue context for PR #${current.number} changed during validation.`
        );
      }
    }
    return current;
  }

  private async publishNeedsHuman(input: {
    readonly request: ValidationRequest;
    readonly pr: PullRequest;
    readonly diff: string;
    readonly snapshot: ValidationSnapshot;
    readonly findings: readonly ReviewFinding[];
    readonly reason: string;
    readonly metrics: Metrics;
    readonly verification?: VerificationResult;
  }): Promise<CoordinatedValidationResult> {
    const markerOutcome = needsHuman(
      input.snapshot.key,
      input.reason,
      input.findings,
      input.metrics,
      input.verification
    );
    const reviewEvent = await input.metrics.stage("publication", () =>
      this.publishReview(
        input.request,
        input.pr,
        input.diff,
        input.findings,
        input.snapshot,
        markerOutcome
      )
    );
    const outcome = {
      ...markerOutcome,
      metrics: input.metrics.finish(),
    };
    return {
      pr: input.pr,
      findings: input.findings,
      repaired: false,
      specSkipped: !input.request.issue,
      reviewEvent,
      outcome,
    };
  }

  private async publishReview(
    request: ValidationRequest,
    pr: PullRequest,
    diff: string,
    findings: readonly ReviewFinding[],
    snapshot: ValidationSnapshot,
    outcome: ValidationOutcome
  ): Promise<"COMMENT" | "REQUEST_CHANGES"> {
    const current = await this.assertFreshOrThrow(request, snapshot);
    const prepared = preparePullRequestReview({
      pr: current,
      diff,
      findings,
      specSkipped: !request.issue,
      metadata: reviewMetadata(snapshot, outcome, findings),
    });
    const body = [
      "<!-- prtisan:summary -->",
      "## Prtisan integration",
      "",
      managedCommentSection(current.comments, "workflow") ??
        "<!-- prtisan:workflow:start -->\nWorkflow state will appear when apply advances this PR.\n<!-- prtisan:workflow:end -->",
      "",
      "<!-- prtisan:validation:start -->",
      prepared.body,
      "<!-- prtisan:validation:end -->",
    ].join("\n");
    await this.githubMutate(() => {
      if (typeof this.deps.github.upsertPullRequestComment === "function") {
        return this.deps.github.upsertPullRequestComment(
          request.config.repo,
          current.number,
          "prtisan:summary",
          body
        );
      }
      return this.deps.github.createPullRequestReview({
        repo: request.config.repo,
        pullNumber: current.number,
        commitId: current.headRefOid,
        event: prepared.event,
        body,
        comments: [],
      });
    });
    return prepared.event;
  }
}

class Metrics {
  private readonly startedAt = Date.now();
  private agentRuns = 0;
  private agentReservations = 0;
  private cacheHits = 0;
  private promptChars = 0;
  private readonly stageTimingsMs: Record<string, number> = {};

  constructor(private readonly maxWallTimeMs: number) {}

  async stage<T>(name: string, task: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await task();
    } finally {
      this.stageTimingsMs[name] =
        (this.stageTimingsMs[name] ?? 0) + (Date.now() - startedAt);
    }
  }

  beforeAgent(config: AgentTrainConfig): void {
    if (this.agentReservations >= config.validation.maxAgentRunsPerHead) {
      throw new AgentBudgetError(
        `Validation exhausted its ${config.validation.maxAgentRunsPerHead} agent-run budget.`
      );
    }
    this.assertWithinBudget();
    this.agentReservations += 1;
  }

  afterAgent(
    output?:
      Pick<ReviewReport, "promptChars"> | { readonly promptChars?: number }
  ): void {
    this.agentRuns += 1;
    this.promptChars += output?.promptChars ?? 0;
    this.assertWithinBudget();
  }

  failedAgent(): void {
    this.agentRuns += 1;
  }

  cacheHit(): void {
    this.cacheHits += 1;
  }

  assertWithinBudget(): void {
    if (Date.now() - this.startedAt >= this.maxWallTimeMs) {
      throw new AgentBudgetError(
        `Validation exhausted its ${this.maxWallTimeMs}ms wall-time budget.`
      );
    }
  }

  budgetedConfig(config: AgentTrainConfig): AgentTrainConfig {
    const remainingMs = Math.max(
      1,
      this.maxWallTimeMs - (Date.now() - this.startedAt)
    );
    return {
      ...config,
      validation: {
        ...config.validation,
        maxWallTimeMs: remainingMs,
      },
    };
  }

  finish(): ValidationMetrics {
    return {
      durationMs: Date.now() - this.startedAt,
      agentRuns: this.agentRuns,
      cacheHits: this.cacheHits,
      promptChars: this.promptChars,
      stageTimingsMs: { ...this.stageTimingsMs },
    };
  }
}

class AgentBudgetError extends Error {}

class StaleSnapshotError extends Error {
  constructor(
    readonly pr: PullRequest,
    message: string
  ) {
    super(message);
  }
}

function validateRepairContract(
  value: unknown,
  blockers: readonly ReviewFinding[]
): string | undefined {
  if (!value || typeof value !== "object") {
    return "The repair agent did not return the required structured repair report.";
  }
  const record = value as Record<string, unknown>;
  const addressed = new Set(
    Array.isArray(record.addressedFindingIds)
      ? record.addressedFindingIds.filter(
          (item): item is string => typeof item === "string"
        )
      : []
  );
  const missing = blockers
    .map((finding) => finding.findingId)
    .filter((id): id is string => Boolean(id && !addressed.has(id)));
  if (missing.length > 0) {
    return `The repair report did not address finding(s): ${missing.join(", ")}.`;
  }
  if (
    !Array.isArray(record.changedPaths) ||
    record.changedPaths.some((path) => typeof path !== "string")
  ) {
    return "The repair report did not provide a valid changedPaths list.";
  }
  return undefined;
}

function unresolvedFindingIds(
  blockers: readonly ReviewFinding[],
  verification: RepairVerificationReport,
  targetedFindings: readonly ReviewFinding[]
): string[] {
  const resolved = new Set(verification.resolvedFindingIds);
  const surviving = new Set(
    targetedFindings
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => finding.findingId)
      .filter((id): id is string => Boolean(id))
  );
  return blockers
    .map((finding) => finding.findingId)
    .filter((id): id is string =>
      Boolean(id && (!resolved.has(id) || surviving.has(id)))
    );
}

function needsHuman(
  snapshotKey: string,
  reason: string,
  findings: readonly ReviewFinding[],
  metrics: Metrics,
  verification?: VerificationResult
): ValidationOutcome {
  return {
    kind: "needs_human",
    snapshotKey,
    reason,
    findings,
    verification,
    metrics: metrics.finish(),
  };
}

function failureResult(input: {
  readonly pr: PullRequest;
  readonly findings?: readonly ReviewFinding[];
  readonly specSkipped: boolean;
  readonly outcome: ValidationOutcome;
}): CoordinatedValidationResult {
  const findings =
    input.findings ??
    ("findings" in input.outcome ? input.outcome.findings : []);
  return {
    pr: input.pr,
    findings,
    repaired: false,
    specSkipped: input.specSkipped,
    reviewEvent: findings.some((finding) => finding.severity === "blocking")
      ? "REQUEST_CHANGES"
      : "COMMENT",
    outcome: input.outcome,
  };
}

function reviewMetadata(
  snapshot: ValidationSnapshot,
  outcome: ValidationOutcome,
  findings: readonly ReviewFinding[]
): ValidationReviewMetadata {
  return {
    schemaVersion: 2,
    baseRefOid: snapshot.baseRefOid,
    snapshotKey: snapshot.key,
    policyDigest: snapshot.policyDigest,
    issueContextDigest: snapshot.issueContextDigest,
    runtimeFingerprint: snapshot.runtimeFingerprint,
    outcome: outcome.kind,
    findingIds: findings
      .map((finding) => finding.findingId)
      .filter((id): id is string => Boolean(id)),
  };
}

async function waitForPullRequestHead(
  github: GitHubClient,
  repo: string,
  pullNumber: number,
  expectedHeadRefOid: string
): Promise<PullRequest> {
  let pr = await github.getPullRequest(repo, pullNumber);
  if (headMatchesExpected(pr.headRefOid, expectedHeadRefOid)) return pr;

  for (
    let attempt = 1;
    attempt < POST_REPAIR_HEAD_REFRESH_ATTEMPTS;
    attempt += 1
  ) {
    await Bun.sleep(POST_REPAIR_HEAD_REFRESH_INTERVAL_MS);
    pr = await github.getPullRequest(repo, pullNumber);
    if (headMatchesExpected(pr.headRefOid, expectedHeadRefOid)) return pr;
  }
  throw new StaleSnapshotError(
    pr,
    `PR #${pullNumber} did not advance to verified repair ${shortSha(
      expectedHeadRefOid
    )}.`
  );
}

function headMatchesExpected(
  headRefOid: string,
  expectedHeadRefOid: string
): boolean {
  return (
    headRefOid === expectedHeadRefOid ||
    headRefOid.startsWith(expectedHeadRefOid)
  );
}

function verificationFailureReason(result: VerificationResult): string {
  const failed = result.commands.find((command) => command.exitCode !== 0);
  return failed
    ? `${failed.name} failed with exit code ${failed.exitCode}: ${failed.output}`
    : "Runtime verification failed.";
}

export function authorizeFindings(
  findings: readonly ReviewFinding[]
): readonly ReviewFinding[] {
  return findings.map((finding) => {
    if (
      finding.severity !== "blocking" ||
      (finding.rule?.trim() && finding.evidence?.trim())
    ) {
      return finding;
    }
    return {
      ...finding,
      severity: "advisory",
      body: `${finding.body}\n\nPrtisan did not authorize this as a blocker because the diagnosis omitted a concrete frozen-contract rule or evidence.`,
    };
  });
}

function provisionalSnapshotKey(pr: PullRequest, error: unknown): string {
  return stableDigest({
    head: pr.headRefOid,
    base: pr.baseRefOid,
    error: errorMessage(error),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48);
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}
