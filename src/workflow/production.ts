import { SandcastleCodexRunner } from "@/agent.js";
import { executeInit } from "@/commands/init.js";
import { executeValidate } from "@/commands/validate.js";
import { DockerBaseImageManager } from "@/docker-image.js";
import type { CommandRunner } from "@/exec.js";
import { GitClient } from "@/git.js";
import {
  GitHubClient,
  managedCommentSection,
  pullRequestCheckStatus,
  pullRequestReadinessBlockers,
} from "@/github.js";
import {
  loadManifestAtRef,
  ManifestMissingError,
  ManifestUpgradeRequiredError,
  type PrtisanManifest,
} from "@/manifest.js";
import { preparePullRequestForMerge } from "@/merge-readiness.js";
import { loadOpenPrGraph } from "@/open-pr-graph.js";
import { joinPath } from "@/path.js";
import { prtisanPaths } from "@/prtisan-paths.js";
import { FileRepairAttemptStore } from "@/repair-attempt-store.js";
import { FileReviewCache } from "@/review-cache.js";
import {
  DeclaredRuntimeProvider,
  DockerVerificationRunner,
} from "@/runtime.js";
import {
  assertSetupPlanFresh,
  createSetupPlan,
  SetupPlanStore,
} from "@/setup-plan.js";
import type { AgentTrainConfig, PullRequest } from "@/types.js";
import { changedFilesFromDiff, stableDigest } from "@/validation-hardening.js";
import { ValidationLeaseManager } from "@/validation-lease.js";

import type {
  FrozenPullRequest,
  PreparationResult,
  PullRequestAttempt,
  RestackResult,
  TrainPlan,
  WorkflowBlocker,
  WorkflowSnapshot,
} from "./types.js";
import {
  freezeContract as freezeCurrentContract,
  SetupRequiredError,
  type WorkflowEnvironment,
  WorkflowStopError,
} from "./workflow.js";

const SUMMARY_MARKER = "prtisan:summary";

export class ProductionWorkflowEnvironment implements WorkflowEnvironment {
  constructor(
    private readonly runner: CommandRunner,
    private readonly log: (message: string) => void = console.error
  ) {}

  async setup(input: { readonly cwd: string }) {
    const plan = await createSetupPlan({
      cwd: input.cwd,
      runner: this.runner,
    });
    const store = await SetupPlanStore.open(prtisanPaths().journal);
    try {
      store.save(plan);
    } finally {
      store.close();
    }
    await assertSetupPlanFresh(plan, this.runner);
    const result = await executeInit(
      {
        cwd: plan.cwd,
        repo: plan.repo,
        targetBranch: plan.targetBranch,
        branch: plan.branch,
        manifest: plan.proposedManifest,
        force: plan.upgrade,
      },
      {
        runner: this.runner,
        github: new GitHubClient(this.runner, plan.cwd),
        log: this.log,
      }
    );
    if (!result.pr) {
      if (
        result.mode === "github" &&
        result.reason ===
          "The Prtisan manifest and Dockerfile already exist on the target branch."
      ) {
        await this.fetch(plan.cwd, plan.targetBranch);
        await loadManifestAtRef({
          runner: this.runner,
          cwd: plan.cwd,
          ref: `origin/${plan.targetBranch}`,
        });
        return { kind: "ready" as const };
      }
      throw new Error(
        result.reason ??
          "Prtisan setup did not create or locate a setup pull request."
      );
    }
    return {
      kind: "waiting" as const,
      cwd: plan.cwd,
      repo: plan.repo,
      targetBranch: plan.targetBranch,
      setupPr: {
        number: result.pr.number,
        url: result.pr.url,
      },
    };
  }

  async inspect(input: { readonly cwd: string }) {
    const cwd = await this.gitRoot(input.cwd);
    const discovered = await this.discoverRepository(cwd);
    await this.fetch(cwd, discovered.defaultBranch);
    let loaded;
    try {
      loaded = await loadManifestAtRef({
        runner: this.runner,
        cwd,
        ref: `origin/${discovered.defaultBranch}`,
      });
    } catch (error) {
      if (
        error instanceof ManifestMissingError ||
        error instanceof ManifestUpgradeRequiredError
      ) {
        throw new SetupRequiredError(error.message);
      }
      throw error;
    }
    if (loaded.manifest.targetBranch !== discovered.defaultBranch) {
      await this.fetch(cwd, loaded.manifest.targetBranch);
      loaded = await loadManifestAtRef({
        runner: this.runner,
        cwd,
        ref: `origin/${loaded.manifest.targetBranch}`,
      });
    }
    const config = configFromManifest(
      discovered.repo,
      loaded.manifest.targetBranch,
      loaded.manifest
    );
    const github = new GitHubClient(this.runner, cwd);
    const git = new GitClient(this.runner, cwd, config);
    const graph = await loadOpenPrGraph({
      github,
      repo: config.repo,
      targetBranch: config.targetBranch,
      concurrency: config.concurrency.github,
    });
    return {
      cwd,
      repo: config.repo,
      targetBranch: config.targetBranch,
      graph,
      manifest: loaded,
      pullRequestAuthority: async (pr: PullRequest) => {
        await this.fetch(cwd, pr.baseRefName);
        const requiredChecks = await github.getRequiredCheckNames(
          config.repo,
          pr.baseRefName
        );
        const diff = await github.getPullRequestDiff(config.repo, pr.number);
        const standards = await git.readStandardsAtRef(
          pr.baseRefOid,
          changedFilesFromDiff(diff)
        );
        return {
          requiredChecks,
          policyDigest: stableDigest({
            baseRefOid: pr.baseRefOid,
            manifestDigest: loaded.digest,
            standards,
          }),
        };
      },
    };
  }

  async listOpenPullRequests(plan: TrainPlan): Promise<readonly PullRequest[]> {
    return this.context(plan).github.listOpenPullRequests(plan.repo);
  }

  async planStaleness(plan: TrainPlan): Promise<WorkflowBlocker | undefined> {
    if (
      plan.pullRequests.some(
        (pullRequest) => pullRequest.manifestDigest !== plan.manifestDigest
      )
    ) {
      return {
        category: "stale",
        message:
          "The frozen plan contains inconsistent repository policy and must be replanned.",
        external: true,
      };
    }
    await this.fetch(plan.cwd, plan.targetBranch);
    const currentManifest = await loadManifestAtRef({
      runner: this.runner,
      cwd: plan.cwd,
      ref: `origin/${plan.targetBranch}`,
    });
    if (currentManifest.digest !== plan.manifestDigest) {
      return {
        category: "stale",
        message: `Repository policy on ${plan.targetBranch} changed after planning.`,
        external: true,
      };
    }
    const context = this.context(plan);
    const graph = await loadOpenPrGraph({
      github: context.github,
      repo: plan.repo,
      targetBranch: plan.targetBranch,
      concurrency: context.config.concurrency.github,
    });
    for (const frozen of plan.pullRequests) {
      const node = graph.nodes.get(frozen.number);
      if (!node) continue;
      const contract = freezeCurrentContract(
        node.pr,
        node.issue,
        frozen.manifest as PrtisanManifest
      );
      if (contract.digest !== frozen.contract.digest) {
        return {
          category: "stale",
          message: `The frozen intent contract for PR #${frozen.number} changed after planning.`,
          external: true,
        };
      }
    }
    return undefined;
  }

  async getPullRequest(
    plan: TrainPlan,
    pullNumber: number
  ): Promise<PullRequest> {
    return this.context(plan).github.getPullRequest(plan.repo, pullNumber);
  }

  async promoteDraft(
    plan: TrainPlan,
    pullNumber: number
  ): Promise<PullRequest> {
    const { github } = this.context(plan);
    const current = await github.getPullRequest(plan.repo, pullNumber);
    if (!current.isDraft) return current;
    await github.markPullRequestReady(plan.repo, pullNumber);
    return github.getPullRequest(plan.repo, pullNumber);
  }

  async prepare(
    plan: TrainPlan,
    frozen: FrozenPullRequest,
    attempt: PullRequestAttempt
  ): Promise<PreparationResult> {
    const context = this.context(plan, attempt.manifest);
    const graph = await loadOpenPrGraph({
      github: context.github,
      repo: plan.repo,
      targetBranch: plan.targetBranch,
      concurrency: context.config.concurrency.github,
    });
    const validatePullRequests = async (pullNumbers: readonly number[]) =>
      executeValidate(
        {
          cwd: plan.cwd,
          config: context.config,
          pullNumbers,
          repair: frozen.contract.kind !== "none",
          runId: `${plan.id}-pr-${frozen.number}`,
          contractOverrides:
            frozen.contract.kind === "pr_body"
              ? {
                  [frozen.number]: {
                    number: frozen.number,
                    title: `PR #${frozen.number} structured contract`,
                    body: frozen.contract.text,
                    state: "OPEN",
                    url: frozen.url,
                    labels: [],
                    blockedBy: [],
                    blocking: [],
                    subIssues: [],
                  },
                }
              : undefined,
        },
        {
          github: context.github,
          git: context.git,
          agent: context.agent,
          runtime: context.runtime,
          verification: context.verification,
          cache: context.cache,
          lease: context.validationLease,
          log: this.log,
        }
      );

    try {
      const ready = await preparePullRequestForMerge(
        {
          cwd: plan.cwd,
          config: context.config,
          graph,
          prNumber: frozen.number,
          runId: `${plan.id}-pr-${frozen.number}`,
        },
        {
          github: context.github,
          git: context.git,
          agent: context.agent,
          runtime: context.runtime,
          verification: context.verification,
          repairAttempts: context.repairAttempts,
          validatePullRequests,
          log: this.log,
        }
      );
      const changed = ready.node.pr.headRefOid !== attempt.headRefOid ? 1 : 0;
      return {
        kind: "ready",
        pullRequest: ready.node.pr,
        repairCandidates: attempt.repairCandidates + changed,
        causeAttempts: attempt.causeAttempts,
      };
    } catch (error) {
      const current = await context.github.getPullRequest(
        plan.repo,
        frozen.number
      );
      const classified = classifyPreparationError(error, current);
      return {
        ...classified,
        pullRequest: current,
        repairCandidates:
          attempt.repairCandidates +
          (current.headRefOid !== attempt.headRefOid ? 1 : 0),
        causeAttempts: attempt.causeAttempts,
      };
    }
  }

  async merge(
    plan: TrainPlan,
    frozen: FrozenPullRequest,
    attempt: PullRequestAttempt
  ): Promise<PullRequest> {
    const { github } = this.context(plan);
    const current = await github.getPullRequest(plan.repo, frozen.number);
    if (current.state === "MERGED") return current;
    if (
      current.headRefOid !== attempt.headRefOid ||
      current.baseRefOid !== attempt.baseRefOid
    ) {
      throw new WorkflowStopError("stale", {
        category: "stale",
        message: `PR #${frozen.number} changed immediately before merge.`,
        external: true,
      });
    }
    const blockers = pullRequestReadinessBlockers(current);
    if (blockers.length > 0) {
      throw new WorkflowStopError("waiting_external", {
        category: current.reviewDecision?.includes("REVIEW")
          ? "human_review"
          : "github_checks",
        message: blockers.join(" "),
        external: true,
      });
    }
    await github.mergePullRequest(
      plan.repo,
      frozen.number,
      attempt.headRefOid,
      "squash"
    );
    return github.waitForPullRequestMerged(plan.repo, frozen.number);
  }

  async restack(
    plan: TrainPlan,
    frozen: FrozenPullRequest,
    children: readonly FrozenPullRequest[]
  ): Promise<RestackResult> {
    const context = this.context(plan);
    const updates: RestackResult["children"][number][] = [];
    for (const child of children) {
      const current = await context.github.getPullRequest(
        plan.repo,
        child.number
      );
      if (current.state === "MERGED") continue;
      if (
        ![child.baseRefName, plan.targetBranch].includes(current.baseRefName)
      ) {
        throw new WorkflowStopError("stale", {
          category: "stale",
          message: `Child PR #${child.number} was externally retargeted before restacking.`,
          external: true,
        });
      }

      let prepared;
      try {
        prepared = await context.git.createRebasedCommit({
          runId: plan.id,
          label: `restack-pr-${child.number}`,
          branch: child.headRefName,
          baseBranch: plan.targetBranch,
          oldBaseAnchorSha: child.baseRefOid,
          sourceRef: child.headRefOid,
        });
      } catch (error) {
        if (frozen.contract.kind === "none" || child.contract.kind === "none") {
          throw new WorkflowStopError("needs_human", {
            category: "restack_conflict",
            message: `PR #${child.number} could not be replayed and both frozen contracts are required to authorize conflict resolution.`,
            evidence: error instanceof Error ? error.message : String(error),
            external: false,
          });
        }
        const repairBranch = `prtisan/repair/restack-${child.number}-${plan.id.slice(-8)}`;
        const targetSha = await context.git.revParseRemoteBranch(
          plan.targetBranch
        );
        const targetManifest = await loadManifestAtRef({
          runner: this.runner,
          cwd: plan.cwd,
          ref: targetSha,
        });
        const repairContext = this.context(plan, targetManifest.manifest);
        const uniqueDiff = await context.git.diffBetween(
          child.baseRefOid,
          child.headRefOid
        );
        await context.git.prepareBranchAt(repairBranch, targetSha);
        try {
          const repairRuntime = await repairContext.runtime.prepare({
            cwd: plan.cwd,
            ref: targetSha,
            config: repairContext.config,
          });
          const repaired = await repairContext.agent.repair({
            kind: "restack-conflict",
            cwd: plan.cwd,
            config: repairContext.config,
            runId: plan.id,
            prNumber: child.number,
            branch: repairBranch,
            baseBranch: plan.targetBranch,
            parentContract: frozen.contract.text,
            childContract: child.contract.text,
            uniqueDiff,
            runtime: repairRuntime,
          });
          const commit = repaired.commits.at(-1);
          const structured = repaired.structuredOutput as
            { readonly changedPaths?: unknown } | undefined;
          if (!commit || !Array.isArray(structured?.changedPaths)) {
            throw new WorkflowStopError("needs_human", {
              category: "restack_conflict",
              message: `PR #${child.number} restack conflict remained ambiguous.`,
              evidence: repaired.stdout,
              external: false,
            });
          }
          prepared = {
            commit,
            nextBaseAnchorSha: targetSha,
            expectedRemoteSha: child.headRefOid,
          };
        } finally {
          await context.git.deleteLocalBranch(repairBranch);
        }
      }

      const attemptManifest = await loadManifestAtRef({
        runner: this.runner,
        cwd: plan.cwd,
        ref: prepared.nextBaseAnchorSha,
      });
      const attemptContext = this.context(plan, attemptManifest.manifest);
      const runtime = await attemptContext.runtime.prepare({
        cwd: plan.cwd,
        ref: prepared.commit,
        config: attemptContext.config,
      });
      const verified = await attemptContext.verification.verify({
        cwd: plan.cwd,
        runId: plan.id,
        label: `restack-pr-${child.number}`,
        ref: prepared.commit,
        config: attemptContext.config,
        runtime,
      });
      if (verified.status !== "passed") {
        throw new WorkflowStopError(
          verified.status === "infra_failed"
            ? "infrastructure_failed"
            : "needs_human",
          {
            category:
              verified.status === "infra_failed"
                ? "infrastructure"
                : "restack_conflict",
            message: `PR #${child.number} restack verification ${verified.status}.`,
            evidence: JSON.stringify(verified.commands),
            external: verified.status === "infra_failed",
          }
        );
      }

      const stillCurrent = await context.github.getPullRequest(
        plan.repo,
        child.number
      );
      const headNeedsPublication = stillCurrent.headRefOid === child.headRefOid;
      const headAlreadyPublished = stillCurrent.headRefOid === prepared.commit;
      if (!headNeedsPublication && !headAlreadyPublished) {
        throw new WorkflowStopError("stale", {
          category: "stale",
          message: `Child PR #${child.number} changed while its restack was being verified.`,
          external: true,
        });
      }
      if (headNeedsPublication) {
        await context.git.pushVerifiedCommit({
          branch: child.headRefName,
          commit: prepared.commit,
          expectedRemoteSha: child.headRefOid,
        });
      }
      if (stillCurrent.baseRefName !== plan.targetBranch) {
        await context.github.editPullRequestBase(
          plan.repo,
          child.number,
          plan.targetBranch
        );
      }
      const refreshed = await waitForHead(
        context.github,
        plan.repo,
        child.number,
        prepared.commit
      );
      const requiredChecks = await context.github.getRequiredCheckNames(
        plan.repo,
        refreshed.baseRefName
      );
      const childDiff = await context.github.getPullRequestDiff(
        plan.repo,
        child.number
      );
      const standards = await context.git.readStandardsAtRef(
        refreshed.baseRefOid,
        changedFilesFromDiff(childDiff)
      );
      updates.push({
        number: child.number,
        headRefOid: refreshed.headRefOid,
        baseRefOid: refreshed.baseRefOid,
        policyDigest: stableDigest({
          baseRefOid: refreshed.baseRefOid,
          manifestDigest: attemptManifest.digest,
          standards,
        }),
        manifestDigest: attemptManifest.digest,
        manifest: attemptManifest.manifest,
        requiredChecks,
      });
    }
    return { children: updates };
  }

  async updateSummary(
    plan: TrainPlan,
    pullNumber: number,
    snapshot: WorkflowSnapshot
  ): Promise<void> {
    const context = this.context(plan);
    const current = await context.github.getPullRequest(plan.repo, pullNumber);
    const attempt = snapshot.attempts.find(
      (value) => value.number === pullNumber
    );
    const lines = [
      `<!-- ${SUMMARY_MARKER} -->`,
      "## Prtisan integration",
      "",
      "<!-- prtisan:workflow:start -->",
      `- Plan: \`${plan.id}\``,
      `- Workflow: \`${snapshot.outcome}\``,
      `- PR attempt: \`${attempt?.outcome ?? "unknown"}\``,
      `- Snapshot: \`${attempt ? `${short(attempt.baseRefOid)}..${short(attempt.headRefOid)}` : "unknown"}\``,
      `- Repair candidates: ${attempt?.repairCandidates ?? 0}/3`,
      "",
      snapshot.blocker
        ? `**Current blocker:** ${snapshot.blocker.message}`
        : snapshot.nextAction,
      "<!-- prtisan:workflow:end -->",
      "",
      managedCommentSection(current.comments, "validation") ??
        "<!-- prtisan:validation:start -->\nValidation has not run for this snapshot.\n<!-- prtisan:validation:end -->",
    ];
    await context.github.upsertPullRequestComment(
      plan.repo,
      pullNumber,
      SUMMARY_MARKER,
      lines.join("\n")
    );
  }

  private context(plan: TrainPlan, manifestValue: unknown = plan.manifest) {
    const manifest = manifestValue as PrtisanManifest;
    const config = configFromManifest(plan.repo, plan.targetBranch, manifest);
    const github = new GitHubClient(this.runner, plan.cwd);
    const git = new GitClient(this.runner, plan.cwd, config);
    const baseImages = new DockerBaseImageManager(this.runner);
    const runtime = new DeclaredRuntimeProvider(baseImages);
    const paths = prtisanPaths();
    const repositoryKey = stableDigest(plan.repo);
    return {
      config,
      github,
      git,
      agent: new SandcastleCodexRunner(this.runner),
      runtime,
      verification: new DockerVerificationRunner(this.runner),
      cache: new FileReviewCache(
        plan.cwd,
        config.validation.cacheTtlDays,
        joinPath(paths.dataRoot, "cache", repositoryKey, "reviews")
      ),
      validationLease: new ValidationLeaseManager(
        plan.cwd,
        config.validation.leaseTtlMs,
        joinPath(paths.stateRoot, "locks", repositoryKey)
      ),
      repairAttempts: new FileRepairAttemptStore(
        plan.cwd,
        config.validation.leaseTtlMs,
        Date.now,
        joinPath(paths.stateRoot, "repair-attempts", repositoryKey)
      ),
    };
  }

  private async gitRoot(cwd: string): Promise<string> {
    const result = await this.runner.run(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd }
    );
    const root = result.stdout.trim();
    if (result.exitCode !== 0 || !root) {
      throw new Error(`Prtisan requires a Git repository; received ${cwd}.`);
    }
    return root;
  }

  private async discoverRepository(
    cwd: string
  ): Promise<{ readonly repo: string; readonly defaultBranch: string }> {
    const result = await this.runner.run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      { cwd }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Unable to discover GitHub repository: ${result.stderr || result.stdout}`
      );
    }
    const value = JSON.parse(result.stdout) as {
      nameWithOwner?: unknown;
      defaultBranchRef?: { name?: unknown };
    };
    if (
      typeof value.nameWithOwner !== "string" ||
      typeof value.defaultBranchRef?.name !== "string"
    ) {
      throw new Error("GitHub repository discovery returned incomplete data.");
    }
    return {
      repo: value.nameWithOwner,
      defaultBranch: value.defaultBranchRef.name,
    };
  }

  private async fetch(cwd: string, branch: string): Promise<void> {
    const result = await this.runner.run(
      "git",
      ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Unable to fetch origin/${branch}: ${result.stderr || result.stdout}`
      );
    }
  }
}

export function configFromManifest(
  repo: string,
  targetBranch: string,
  manifest: PrtisanManifest
): AgentTrainConfig {
  return {
    repo,
    targetBranch,
    remote: "origin",
    agentProfiles: manifest.codex.roles,
    concurrency: {
      validate: manifest.limits.readConcurrency,
      github: manifest.limits.githubConcurrency,
    },
    docker: {
      imageName: manifest.sandbox.imageName,
      imagePolicy: "managed",
      dockerfile: manifest.sandbox.dockerfile,
      context: manifest.sandbox.context,
      codexHome: "prtisan://codex-home",
      cpus: manifest.sandbox.cpus,
      mounts: [],
    },
    runtime: {
      autoProvision: false,
      verificationMode: "explicit",
      probes: [],
      bootstrap: manifest.verification.bootstrap,
      verification: manifest.verification.commands,
    },
    validation: {
      maxRepairRounds: manifest.limits.maxRepairCandidates,
      maxAgentRunsPerHead: 4,
      maxWallTimeMs: 30 * 60 * 1000,
      promptCharBudget: 32_000,
      maxCheckLogChars: 8_000,
      maxCheckEvidenceChars: 16_000,
      checkStartTimeoutMs: 2 * 60 * 1000,
      checkCompletionTimeoutMs: 15 * 60 * 1000,
      leaseTtlMs: manifest.limits.applyLeaseTtlMs,
      cacheTtlDays: 14,
    },
    retention: {
      ttlDays: 14,
      maxLogBytes: 10 * 1024 * 1024,
      keepSessions: true,
      sessionPolicy: "failures",
      maxRuns: 100,
      maxTotalBytes: 1024 * 1024 * 1024,
    },
  };
}

function classifyPreparationError(
  error: unknown,
  current: PullRequest
): Omit<PreparationResult, "pullRequest"> {
  const message = error instanceof Error ? error.message : String(error);
  if (/changed|stale|no longer open/i.test(message)) {
    return {
      kind: "stale",
      blocker: blocker("stale", message, true),
    };
  }
  if (/review approval|REVIEW_REQUIRED|requested changes/i.test(message)) {
    return {
      kind: "waiting_external",
      blocker: blocker("human_review", message, true),
    };
  }
  if (
    /sudo:|password is required|runner|credential|authentication|permission denied|docker daemon|network|could not resolve|no space left|service unavailable/i.test(
      message
    )
  ) {
    return {
      kind: "waiting_external",
      blocker: blocker("infrastructure", message, true),
    };
  }
  if (
    /after \d+ bounded CI repair|repair budget|consumed.*repair/i.test(message)
  ) {
    return {
      kind: "repair_exhausted",
      blocker: blocker("repair_budget", message, false),
    };
  }
  if (/infra_failed|host verification|runtime|Docker image/i.test(message)) {
    return {
      kind: "infrastructure_failed",
      blocker: blocker("infrastructure", message, true),
    };
  }
  const checks = pullRequestCheckStatus(current);
  if (checks.failed.length > 0 || checks.pending.length > 0) {
    return {
      kind: "waiting_external",
      blocker: blocker("github_checks", message, true),
    };
  }
  return {
    kind: "needs_human",
    blocker: blocker("contract", message, false),
  };
}

function blocker(
  category: WorkflowBlocker["category"],
  message: string,
  external: boolean
): WorkflowBlocker {
  return { category, message, external };
}

async function waitForHead(
  github: GitHubClient,
  repo: string,
  pullNumber: number,
  expected: string
): Promise<PullRequest> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await github.getPullRequest(repo, pullNumber);
    if (
      current.headRefOid === expected ||
      current.headRefOid.startsWith(expected) ||
      expected.startsWith(current.headRefOid)
    ) {
      return current;
    }
    await Bun.sleep(2_000);
  }
  throw new WorkflowStopError("infrastructure_failed", {
    category: "infrastructure",
    message: `GitHub did not observe the published head for PR #${pullNumber}.`,
    external: true,
  });
}

function short(value: string): string {
  return value.slice(0, 7);
}
