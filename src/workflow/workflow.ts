import type { LoadedManifest, PrtisanManifest } from "@/manifest.js";
import type { OpenPrGraph } from "@/open-pr-graph.js";
import type { PullRequest } from "@/types.js";
import { stableDigest } from "@/validation-hardening.js";

import type { ArtifactStore } from "./artifacts.js";
import { type WorkflowJournal, WorkflowLeaseBusyError } from "./journal.js";
import type {
  FrozenPullRequest,
  PreparationResult,
  PullRequestAttempt,
  RestackResult,
  TrainPlan,
  WorkflowBlocker,
  WorkflowEvent,
  WorkflowRemediation,
  WorkflowSnapshot,
} from "./types.js";

export interface WorkflowClock {
  now(): Date;
}

export interface WorkflowEnvironment {
  setup?(input: PlanInput): Promise<WorkflowSetupResult>;
  authenticate?(plan: TrainPlan): Promise<WorkflowAuthenticationResult>;
  cleanup?(plan: TrainPlan): Promise<void>;
  inspect(input: { readonly cwd: string }): Promise<{
    readonly cwd: string;
    readonly repo: string;
    readonly targetBranch: string;
    readonly graph: OpenPrGraph;
    readonly manifest: LoadedManifest;
    readonly pullRequestAuthority: (pr: PullRequest) => Promise<{
      readonly requiredChecks: readonly string[];
      readonly policyDigest: string;
    }>;
  }>;
  listOpenPullRequests(plan: TrainPlan): Promise<readonly PullRequest[]>;
  planStaleness?(plan: TrainPlan): Promise<WorkflowBlocker | undefined>;
  getPullRequest(plan: TrainPlan, pullNumber: number): Promise<PullRequest>;
  promoteDraft(plan: TrainPlan, pullNumber: number): Promise<PullRequest>;
  prepare(
    plan: TrainPlan,
    frozen: FrozenPullRequest,
    attempt: PullRequestAttempt
  ): Promise<PreparationResult>;
  merge(
    plan: TrainPlan,
    frozen: FrozenPullRequest,
    attempt: PullRequestAttempt
  ): Promise<PullRequest>;
  restack(
    plan: TrainPlan,
    frozen: FrozenPullRequest,
    children: readonly FrozenPullRequest[]
  ): Promise<RestackResult>;
  updateSummary(
    plan: TrainPlan,
    pullNumber: number,
    snapshot: WorkflowSnapshot
  ): Promise<void>;
}

export interface PlanInput {
  readonly cwd: string;
}

export interface WorkflowSetupCheckpoint {
  readonly cwd: string;
  readonly repo: string;
  readonly targetBranch: string;
  readonly setupPr: {
    readonly number: number;
    readonly url: string;
  };
}

export type WorkflowSetupResult =
  | ({ readonly kind: "waiting" } & WorkflowSetupCheckpoint)
  | { readonly kind: "ready" };

export type WorkflowAuthenticationResult =
  | {
      readonly kind: "waiting";
      readonly codexHome: string;
      readonly loginCommand: string;
      readonly message?: string;
    }
  | { readonly kind: "ready" };

export interface WorkflowExport {
  readonly plan: TrainPlan;
  readonly snapshot: WorkflowSnapshot;
  readonly events: readonly WorkflowEvent[];
  readonly artifact: {
    readonly digest: string;
    readonly path: string;
  };
}

export type WorkflowRunResult =
  | {
      readonly kind: "train";
      readonly cwd: string;
      readonly repo: string;
      readonly planId: string;
      readonly snapshot: WorkflowSnapshot;
    }
  | {
      readonly kind: "setup";
      readonly cwd: string;
      readonly repo: string;
      readonly targetBranch: string;
      readonly outcome: "waiting_external";
      readonly setupPr: {
        readonly number: number;
        readonly url: string;
      };
      readonly blocker: WorkflowBlocker;
    }
  | {
      readonly kind: "busy";
      readonly cwd: string;
      readonly repo: string;
      readonly planId: string;
      readonly outcome: "waiting_external";
      readonly activeRun: {
        readonly pid: number;
        readonly startedAt: string;
      };
      readonly blocker: WorkflowBlocker;
    }
  | {
      readonly kind: "authentication";
      readonly cwd: string;
      readonly repo: string;
      readonly outcome: "waiting_external";
      readonly authentication: WorkflowRemediation;
      readonly blocker: WorkflowBlocker;
    };

export class SetupRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupRequiredError";
  }
}

export class WorkflowStopError extends Error {
  constructor(
    readonly outcome:
      | "stale"
      | "waiting_external"
      | "needs_human"
      | "repair_exhausted"
      | "invalid_plan"
      | "infrastructure_failed",
    readonly blocker: WorkflowBlocker
  ) {
    super(blocker.message);
    this.name = "WorkflowStopError";
  }
}

export class PrtisanWorkflow {
  constructor(
    private readonly journal: WorkflowJournal,
    private readonly artifacts: ArtifactStore,
    private readonly environment: WorkflowEnvironment,
    private readonly clock: WorkflowClock = { now: () => new Date() }
  ) {}

  async run(input: PlanInput): Promise<WorkflowRunResult> {
    let candidate: TrainPlan;
    try {
      candidate = await this.buildPlan(input);
    } catch (error) {
      if (!(error instanceof SetupRequiredError) || !this.environment.setup) {
        throw error;
      }
      const setup = await this.environment.setup(input);
      if (setup.kind === "waiting") {
        return {
          kind: "setup",
          cwd: setup.cwd,
          repo: setup.repo,
          targetBranch: setup.targetBranch,
          setupPr: setup.setupPr,
          outcome: "waiting_external",
          blocker: {
            category: "policy",
            message: `Merge setup PR #${setup.setupPr.number} so the reviewed Prtisan configuration reaches ${setup.targetBranch}.`,
            external: true,
          },
        };
      }
      candidate = await this.buildPlan(input);
    }
    const authentication = await this.environment.authenticate?.(candidate);
    if (authentication?.kind === "waiting") {
      const remediation = {
        kind: "codex_login" as const,
        codexHome: authentication.codexHome,
        command: authentication.loginCommand,
      };
      return {
        kind: "authentication",
        cwd: candidate.cwd,
        repo: candidate.repo,
        outcome: "waiting_external",
        authentication: remediation,
        blocker: {
          category: "credentials",
          message:
            authentication.message ??
            "Codex authentication is required for Prtisan.",
          remediation,
          external: true,
        },
      };
    }
    const existing = await this.journal.latestPlan(candidate.repositoryKey);
    const existingSnapshot = existing
      ? await this.journal.snapshot(existing.id)
      : undefined;
    let plan =
      existing && existingSnapshot?.outcome !== "completed"
        ? existing
        : candidate;
    if (plan === candidate) await this.persistPlan(plan);
    try {
      let snapshot = await this.apply(plan.id);
      if (plan === existing && snapshot.outcome === "stale") {
        plan = candidate;
        await this.persistPlan(plan);
        snapshot = await this.apply(plan.id);
      }
      return {
        kind: "train",
        cwd: plan.cwd,
        repo: plan.repo,
        planId: plan.id,
        snapshot,
      };
    } catch (error) {
      if (!(error instanceof WorkflowLeaseBusyError)) throw error;
      return {
        kind: "busy",
        cwd: plan.cwd,
        repo: plan.repo,
        planId: plan.id,
        outcome: "waiting_external",
        activeRun: {
          pid: error.ownerPid,
          startedAt: error.ownerCreatedAt,
        },
        blocker: {
          category: "infrastructure",
          message: error.message,
          external: true,
        },
      };
    }
  }

  async plan(input: PlanInput): Promise<TrainPlan> {
    const plan = await this.buildPlan(input);
    await this.persistPlan(plan);
    return plan;
  }

  private async buildPlan(input: PlanInput): Promise<TrainPlan> {
    const inspected = await this.environment.inspect(input);
    const invalid = graphProblem(inspected.graph);
    if (invalid) throw new Error(invalid);

    const frozen = await Promise.all(
      inspected.graph.topologicalOrder.map(async (number) => {
        const node = inspected.graph.nodes.get(number);
        if (!node) throw new Error(`Open PR graph lost PR #${number}.`);
        const parent = node.blockers[0];
        const children = node.blocking;
        const authority = await inspected.pullRequestAuthority(node.pr);
        const contract = freezeContract(
          node.pr,
          node.issue,
          inspected.manifest.manifest
        );
        const policyDigest = authority.policyDigest;
        const checkStateDigest = stableDigest(node.pr.statusCheckRollup ?? []);
        const snapshotKey = stableDigest({
          number,
          headRefOid: node.pr.headRefOid,
          baseRefOid: node.pr.baseRefOid,
          contractDigest: contract.digest,
          policyDigest,
          manifestDigest: inspected.manifest.digest,
          requiredChecks: authority.requiredChecks,
          reviewDecision: node.pr.reviewDecision,
          checkStateDigest,
        });
        return {
          number,
          url: node.pr.url,
          title: node.pr.title,
          body: node.pr.body,
          headRefName: node.pr.headRefName,
          baseRefName: node.pr.baseRefName,
          headRefOid: node.pr.headRefOid,
          baseRefOid: node.pr.baseRefOid,
          isDraft: node.pr.isDraft ?? false,
          reviewDecision: node.pr.reviewDecision,
          checkStateDigest,
          parent,
          children,
          issue: node.issue
            ? {
                number: node.issue.number,
                title: node.issue.title,
                body: node.issue.body,
                url: node.issue.url,
              }
            : undefined,
          contract,
          policyDigest,
          manifestDigest: inspected.manifest.digest,
          manifest: inspected.manifest.manifest,
          requiredChecks: [...authority.requiredChecks].sort(),
          snapshotKey,
        } satisfies FrozenPullRequest;
      })
    );

    const createdAt = this.clock.now().toISOString();
    const planValue = {
      schemaVersion: 1 as const,
      repositoryKey: stableDigest({
        repo: inspected.repo,
        cwd: inspected.cwd,
      }),
      cwd: inspected.cwd,
      repo: inspected.repo,
      targetBranch: inspected.targetBranch,
      createdAt,
      manifestDigest: inspected.manifest.digest,
      manifest: inspected.manifest.manifest,
      pullRequests: frozen,
      topologicalOrder: [...inspected.graph.topologicalOrder],
    };
    const planDigest = stableDigest(planValue);
    const plan: TrainPlan = {
      ...planValue,
      id: `plan-${planDigest.slice(0, 16)}`,
      planDigest,
    };
    return plan;
  }

  private async persistPlan(plan: TrainPlan): Promise<void> {
    await this.journal.savePlan(plan, {
      type: "plan_created",
      at: plan.createdAt,
      planId: plan.id,
      repositoryKey: plan.repositoryKey,
      pullRequests: plan.pullRequests,
    });
  }

  async apply(planId: string): Promise<WorkflowSnapshot> {
    const plan = await this.requirePlan(planId);
    const acquiredAt = this.clock.now();
    const owner = {
      token: crypto.randomUUID(),
      pid: process.pid,
      createdAt: acquiredAt.toISOString(),
    };
    const manifest = plan.manifest as PrtisanManifest;
    const lease = await this.journal.acquire(
      plan.repositoryKey,
      owner,
      acquiredAt.getTime(),
      manifest.limits.applyLeaseTtlMs
    );

    try {
      await this.journal.append(plan.id, {
        type: "apply_started",
        at: this.at(),
      });
      await this.environment.cleanup?.(plan);
      const stale = await this.findStaleness(plan);
      if (stale) return this.block(plan, "stale", stale);

      for (const pullNumber of plan.topologicalOrder) {
        const snapshot = await this.requireSnapshot(plan.id);
        const frozen = requireFrozen(plan, pullNumber);
        if (snapshot.merged.includes(pullNumber)) {
          await this.finalizeMergedPullRequest(plan, frozen);
          continue;
        }
        let attempt = requireAttempt(snapshot, pullNumber);
        if (frozen.parent && !snapshot.merged.includes(frozen.parent)) {
          return this.block(plan, "invalid_plan", {
            category: "policy",
            message: `PR #${pullNumber} reached the frontier before parent PR #${frozen.parent}.`,
            external: false,
          });
        }

        let current = await this.environment.getPullRequest(plan, pullNumber);
        const mismatch = attemptMismatch(attempt, current);
        if (mismatch) return this.block(plan, "stale", mismatch);

        if (frozen.isDraft) {
          attempt = { ...attempt, outcome: "promoting_draft" };
          await this.changeAttempt(plan, attempt);
          current = await this.effect(
            plan,
            `promote:${pullNumber}:${current.headRefOid}`,
            () => this.environment.promoteDraft(plan, pullNumber)
          );
        }

        attempt = {
          ...attempt,
          outcome: "preparing",
          headRefOid: current.headRefOid,
          baseRefOid: current.baseRefOid,
        };
        await this.changeAttempt(plan, attempt);
        const prepared = await this.environment.prepare(plan, frozen, attempt);
        if (prepared.kind !== "ready") {
          const blockedAttempt: PullRequestAttempt = {
            ...attempt,
            outcome: prepared.kind,
            headRefOid: prepared.pullRequest.headRefOid,
            baseRefOid: prepared.pullRequest.baseRefOid,
            repairCandidates:
              prepared.repairCandidates ?? attempt.repairCandidates,
            causeAttempts: prepared.causeAttempts ?? attempt.causeAttempts,
            blocker: prepared.blocker,
          };
          await this.changeAttempt(plan, blockedAttempt);
          return this.block(
            plan,
            prepared.kind,
            prepared.blocker ?? fallbackBlocker(prepared.kind, pullNumber)
          );
        }

        attempt = {
          ...attempt,
          outcome: "ready",
          headRefOid: prepared.pullRequest.headRefOid,
          baseRefOid: prepared.pullRequest.baseRefOid,
          repairCandidates:
            prepared.repairCandidates ?? attempt.repairCandidates,
          causeAttempts: prepared.causeAttempts ?? attempt.causeAttempts,
          blocker: undefined,
        };
        await this.changeAttempt(plan, attempt);

        attempt = { ...attempt, outcome: "merging" };
        await this.changeAttempt(plan, attempt);
        const merged = await this.effect(
          plan,
          `merge:${pullNumber}:${attempt.headRefOid}`,
          () => this.environment.merge(plan, frozen, attempt)
        );
        if (merged.state !== "MERGED") {
          return this.block(plan, "infrastructure_failed", {
            category: "infrastructure",
            message: `GitHub did not report PR #${pullNumber} as merged.`,
            external: true,
          });
        }

        attempt = {
          ...attempt,
          outcome: "merged",
          headRefOid: merged.headRefOid,
          baseRefOid: merged.baseRefOid,
        };
        await this.changeAttempt(plan, attempt);
        await this.journal.append(plan.id, {
          type: "pull_request_merged",
          at: this.at(),
          pullNumber,
        });

        await this.finalizeMergedPullRequest(plan, frozen);
      }

      await this.journal.append(plan.id, {
        type: "workflow_completed",
        at: this.at(),
      });
      return this.requireSnapshot(plan.id);
    } catch (error) {
      if (error instanceof WorkflowStopError) {
        return this.block(plan, error.outcome, error.blocker);
      }
      return this.block(plan, "infrastructure_failed", {
        category: "infrastructure",
        message: error instanceof Error ? error.message : String(error),
        external: true,
      });
    } finally {
      await lease.release();
    }
  }

  async status(planId: string): Promise<WorkflowSnapshot> {
    await this.requirePlan(planId);
    return this.requireSnapshot(planId);
  }

  async export(planId: string): Promise<WorkflowExport> {
    const plan = await this.requirePlan(planId);
    const events = await this.journal.events(planId);
    const snapshot = await this.requireSnapshot(planId);
    const artifact = await this.artifacts.put(
      `${JSON.stringify({ plan, snapshot, events }, null, 2)}\n`
    );
    return { plan, snapshot, events, artifact };
  }

  private async findStaleness(
    plan: TrainPlan
  ): Promise<WorkflowBlocker | undefined> {
    const authorityChange = await this.environment.planStaleness?.(plan);
    if (authorityChange) return authorityChange;
    const snapshot = await this.requireSnapshot(plan.id);
    const currentOpen = await this.environment.listOpenPullRequests(plan);
    const expectedOpen = new Set(
      plan.pullRequests
        .filter((pr) => !snapshot.merged.includes(pr.number))
        .map((pr) => pr.number)
    );
    const unexpected = currentOpen.filter((pr) => !expectedOpen.has(pr.number));
    if (unexpected.length > 0) {
      return {
        category: "stale",
        message: `The open train gained ${unexpected
          .map((pr) => `PR #${pr.number}`)
          .join(", ")} after planning.`,
        external: true,
      };
    }

    for (const attempt of snapshot.attempts) {
      if (snapshot.merged.includes(attempt.number)) continue;
      const current = await this.environment.getPullRequest(
        plan,
        attempt.number
      );
      const mismatch = attemptMismatch(attempt, current);
      if (mismatch) {
        const frozen = requireFrozen(plan, attempt.number);
        if (frozen.parent && snapshot.merged.includes(frozen.parent)) {
          const parentAttempt = requireAttempt(snapshot, frozen.parent);
          const restack = await this.journal.effect(
            plan.id,
            `restack:${frozen.parent}:${parentAttempt.headRefOid}`
          );
          if (restack) continue;
        }
        return mismatch;
      }
    }
    return undefined;
  }

  private async effect<T>(
    plan: TrainPlan,
    key: string,
    execute: () => Promise<T>
  ): Promise<T> {
    const existing = await this.journal.effect(plan.id, key);
    if (existing?.status === "completed") return existing.result as T;
    await this.journal.startEffect(plan.id, key, this.at());
    const result = await execute();
    await this.journal.completeEffect(plan.id, key, result, this.at());
    return result;
  }

  private async finalizeMergedPullRequest(
    plan: TrainPlan,
    frozen: FrozenPullRequest
  ): Promise<void> {
    let snapshot = await this.requireSnapshot(plan.id);
    const attempt = requireAttempt(snapshot, frozen.number);
    const children = frozen.children
      .map((number) => plan.pullRequests.find((pr) => pr.number === number))
      .filter((value): value is FrozenPullRequest => Boolean(value));
    if (children.length > 0) {
      const restacked = await this.effect(
        plan,
        `restack:${frozen.number}:${attempt.headRefOid}`,
        () => this.environment.restack(plan, frozen, children)
      );
      for (const child of restacked.children) {
        snapshot = await this.requireSnapshot(plan.id);
        const childAttempt = requireAttempt(snapshot, child.number);
        if (
          childAttempt.headRefOid === child.headRefOid &&
          childAttempt.baseRefOid === child.baseRefOid
        ) {
          continue;
        }
        await this.changeAttempt(plan, {
          ...childAttempt,
          outcome: "pending",
          headRefOid: child.headRefOid,
          baseRefOid: child.baseRefOid,
          policyDigest: child.policyDigest,
          manifestDigest: child.manifestDigest,
          manifest: child.manifest,
          requiredChecks: child.requiredChecks,
          blocker: undefined,
        });
      }
    }

    snapshot = await this.requireSnapshot(plan.id);
    await this.effect(
      plan,
      `summary:${frozen.number}:${attempt.headRefOid}`,
      async () => {
        await this.environment.updateSummary(plan, frozen.number, snapshot);
        return { updated: true };
      }
    );
  }

  private async changeAttempt(
    plan: TrainPlan,
    attempt: PullRequestAttempt
  ): Promise<void> {
    await this.journal.append(plan.id, {
      type: "attempt_changed",
      at: this.at(),
      attempt,
    });
  }

  private async block(
    plan: TrainPlan,
    outcome:
      | "stale"
      | "waiting_external"
      | "needs_human"
      | "repair_exhausted"
      | "invalid_plan"
      | "infrastructure_failed",
    blocker: WorkflowBlocker
  ): Promise<WorkflowSnapshot> {
    await this.journal.append(plan.id, {
      type: "workflow_blocked",
      at: this.at(),
      outcome,
      blocker,
    });
    const snapshot = await this.requireSnapshot(plan.id);
    const active = snapshot.attempts.find(
      (attempt) => attempt.outcome !== "merged" && attempt.outcome !== "pending"
    );
    if (active) {
      await this.environment
        .updateSummary(plan, active.number, snapshot)
        .catch(() => undefined);
    }
    return snapshot;
  }

  private async requirePlan(planId: string): Promise<TrainPlan> {
    const plan = await this.journal.loadPlan(planId);
    if (!plan) throw new Error(`Unknown Prtisan plan: ${planId}.`);
    return plan;
  }

  private async requireSnapshot(planId: string): Promise<WorkflowSnapshot> {
    const snapshot = await this.journal.snapshot(planId);
    if (!snapshot) throw new Error(`Plan ${planId} has no journal events.`);
    return snapshot;
  }

  private at(): string {
    return this.clock.now().toISOString();
  }
}

function graphProblem(graph: OpenPrGraph): string | undefined {
  for (const node of graph.nodes.values()) {
    if (node.blockers.length > 1) {
      return `PR #${node.pr.number} has multiple open parents (${node.blockers
        .map((number) => `#${number}`)
        .join(
          ", "
        )}). Prtisan v1 supports only roots and single-parent stacks; linearise this join before planning.`;
    }
  }
  return undefined;
}

export function freezeContract(
  pr: PullRequest,
  issue: { readonly number: number; readonly body: string } | undefined,
  manifest: PrtisanManifest
): FrozenPullRequest["contract"] {
  if (issue) {
    const text = issue.body.trim();
    return {
      kind: "issue",
      digest: stableDigest({ issue: issue.number, text }),
      text,
    };
  }

  const sections = manifest.contract.prBodySections
    .map((heading) => extractMarkdownSection(pr.body, heading))
    .filter((value): value is string => Boolean(value));
  if (sections.length !== manifest.contract.prBodySections.length) {
    return { kind: "none", digest: stableDigest("uncontracted") };
  }
  const text = sections.join("\n\n");
  return { kind: "pr_body", digest: stableDigest(text), text };
}

function extractMarkdownSection(
  body: string,
  heading: string
): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|\\n)#{2,6}\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n#{2,6}\\s+|$)`,
    "i"
  ).exec(body);
  const value = match?.[1]?.trim();
  return value ? `## ${heading}\n\n${value}` : undefined;
}

function requireFrozen(plan: TrainPlan, number: number): FrozenPullRequest {
  const frozen = plan.pullRequests.find((pr) => pr.number === number);
  if (!frozen)
    throw new Error(`Plan ${plan.id} does not contain PR #${number}.`);
  return frozen;
}

function requireAttempt(
  snapshot: WorkflowSnapshot,
  number: number
): PullRequestAttempt {
  const attempt = snapshot.attempts.find((item) => item.number === number);
  if (!attempt) {
    throw new Error(`Workflow snapshot has no attempt for PR #${number}.`);
  }
  return attempt;
}

function attemptMismatch(
  attempt: PullRequestAttempt,
  current: PullRequest
): WorkflowBlocker | undefined {
  if (current.state === "MERGED" && attempt.outcome === "merged")
    return undefined;
  if (
    current.headRefOid !== attempt.headRefOid ||
    current.baseRefOid !== attempt.baseRefOid
  ) {
    return {
      category: "stale",
      message: `PR #${attempt.number} changed from ${short(
        attempt.baseRefOid
      )}..${short(attempt.headRefOid)} to ${short(
        current.baseRefOid
      )}..${short(current.headRefOid)}.`,
      external: true,
    };
  }
  return undefined;
}

function short(value: string): string {
  return value.slice(0, 7);
}

function fallbackBlocker(
  kind: Exclude<PreparationResult["kind"], "ready">,
  pullNumber: number
): WorkflowBlocker {
  const external =
    kind === "waiting_external" || kind === "infrastructure_failed";
  return {
    category:
      kind === "repair_exhausted"
        ? "repair_budget"
        : kind === "stale"
          ? "stale"
          : kind === "waiting_external"
            ? "github_checks"
            : kind === "infrastructure_failed"
              ? "infrastructure"
              : "contract",
    message: `PR #${pullNumber} preparation ended with ${kind}.`,
    external,
  };
}
