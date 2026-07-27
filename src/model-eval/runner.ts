import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentInfrastructureError,
  AgentOutputError,
  SandcastleCodexRunner,
} from "@/agent.js";
import { calculateCreditCost } from "@/codex-rate-card.js";
import { DockerBaseImageManager } from "@/docker-image.js";
import { BunCommandRunner, type CommandRunner, mustRun } from "@/exec.js";
import {
  DeclaredRuntimeProvider,
  DockerVerificationRunner,
} from "@/runtime.js";
import type {
  AgentInvocationMetrics,
  AgentRunOutcome,
  AgentTrainConfig,
  RepairVerificationReport,
  ReviewReport,
  SandboxCommandConfig,
} from "@/types.js";
import { stableDigest } from "@/validation-hardening.js";

import { PrivateEvaluationArtifactStore } from "./corpus.js";
import { scoreEvaluationCase } from "./scoring.js";
import type {
  CandidateCaseResult,
  CandidateFinding,
  EvaluationCase,
  EvaluationObservation,
  EvaluationProfile,
} from "./types.js";

export class LiveModelEvaluationRunner {
  constructor(
    private readonly commandRunner: CommandRunner = new BunCommandRunner(),
    private readonly artifacts?: PrivateEvaluationArtifactStore
  ) {}

  async execute(input: {
    readonly runId: string;
    readonly evaluationCase: EvaluationCase;
    readonly profile: EvaluationProfile;
    readonly replicate: number;
  }): Promise<EvaluationObservation> {
    const startedAt = Date.now();
    try {
      return await retryPreAgentInfrastructure((infrastructureRetries) =>
        this.executeOnce(input, startedAt, infrastructureRetries)
      );
    } catch (error) {
      if (error instanceof CorpusMaterializationError) throw error;
      const invocation =
        error instanceof PostAgentInfrastructureError
          ? error.invocation
          : error instanceof AgentOutputError
            ? error.invocation
            : undefined;
      const malformed = error instanceof AgentOutputError;
      const infrastructure =
        error instanceof AgentInfrastructureError ||
        error instanceof PreAgentInfrastructureExhaustedError ||
        error instanceof PostAgentInfrastructureError;
      return {
        schemaVersion: 1,
        runId: input.runId,
        caseId: input.evaluationCase.id,
        repository: input.evaluationCase.repository,
        role: input.evaluationCase.role,
        split: input.evaluationCase.split,
        profile: input.profile,
        replicate: input.replicate,
        terminalOutcome: malformed
          ? "completed"
          : infrastructure
            ? "infrastructure_failed"
            : "execution_failed",
        excludedFromQuality: infrastructure,
        score: malformed
          ? scoreEvaluationCase(
              input.evaluationCase,
              malformedCandidateResult(input.evaluationCase)
            )
          : undefined,
        usage: invocation?.usage,
        credits:
          invocation?.usage === undefined
            ? undefined
            : calculateCreditCost(input.profile.model, invocation.usage)
                ?.credits,
        agentDurationMs: invocation?.agentDurationMs,
        endToEndDurationMs: Date.now() - startedAt,
        retryCount:
          invocation?.retryCount ??
          (error instanceof PreAgentInfrastructureExhaustedError ? 1 : 0),
        cacheUsed: invocation?.cacheUsed,
      };
    }
  }

  private async executeOnce(
    input: {
      readonly runId: string;
      readonly evaluationCase: EvaluationCase;
      readonly profile: EvaluationProfile;
      readonly replicate: number;
    },
    startedAt: number,
    infrastructureRetries: number
  ): Promise<EvaluationObservation> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "prtisan-model-eval-"));
    const cwd = join(workspaceRoot, "repository");
    try {
      let config: AgentTrainConfig;
      let runtime: Awaited<ReturnType<DeclaredRuntimeProvider["prepare"]>>;
      try {
        await materializeCase(this.commandRunner, input.evaluationCase, cwd);
        config = evaluationConfig(input.evaluationCase, input.profile);
        runtime = await new DeclaredRuntimeProvider(
          new DockerBaseImageManager(this.commandRunner)
        ).prepare({
          cwd,
          ref: input.evaluationCase.execution.headRef,
          config,
        });
      } catch (error) {
        if (error instanceof CorpusMaterializationError) throw error;
        throw new AgentInfrastructureError(
          `Pre-agent evaluation setup failed for ${input.evaluationCase.id}.`,
          { cause: error }
        );
      }
      const agent = new SandcastleCodexRunner(this.commandRunner);
      const task = input.evaluationCase.execution.task;
      const agentResult = await executeAgentTask({
        agent,
        cwd,
        config,
        runtime,
        runId: input.runId,
        evaluationCase: input.evaluationCase,
        task,
      });
      const candidate = await candidateResult({
        commandRunner: this.commandRunner,
        cwd,
        config,
        runtime,
        runId: input.runId,
        evaluationCase: input.evaluationCase,
        agentResult,
      });
      const score = scoreEvaluationCase(input.evaluationCase, candidate);
      const invocation = agentResult.invocation;
      const patch = await this.commandRunner.run(
        "git",
        [
          "diff",
          "--binary",
          `${input.evaluationCase.execution.baseRef}...${branchForTask(task)}`,
        ],
        { cwd }
      );
      await this.artifacts?.write(
        input.runId,
        input.evaluationCase.id,
        `${input.profile.model}-${input.profile.reasoningEffort}-${input.replicate}`,
        {
          candidate,
          patch: patch.exitCode === 0 ? patch.stdout : undefined,
          rawOutput:
            "rawOutput" in agentResult
              ? agentResult.rawOutput
              : "stdout" in agentResult
                ? agentResult.stdout
                : undefined,
          structuredOutput:
            "structuredOutput" in agentResult
              ? agentResult.structuredOutput
              : undefined,
        }
      );
      return {
        schemaVersion: 1,
        runId: input.runId,
        caseId: input.evaluationCase.id,
        repository: input.evaluationCase.repository,
        role: input.evaluationCase.role,
        split: input.evaluationCase.split,
        profile: input.profile,
        replicate: input.replicate,
        terminalOutcome: "completed",
        excludedFromQuality: false,
        score,
        usage: invocation?.usage,
        credits:
          invocation?.usage === undefined
            ? undefined
            : calculateCreditCost(input.profile.model, invocation.usage)
                ?.credits,
        agentDurationMs: invocation?.agentDurationMs,
        endToEndDurationMs: Date.now() - startedAt,
        retryCount: infrastructureRetries + (invocation?.retryCount ?? 0),
        cacheUsed: invocation?.cacheUsed,
      };
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

type AgentEvaluationResult =
  ReviewReport | RepairVerificationReport | AgentRunOutcome;

async function executeAgentTask(input: {
  readonly agent: SandcastleCodexRunner;
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runtime: Awaited<ReturnType<DeclaredRuntimeProvider["prepare"]>>;
  readonly runId: string;
  readonly evaluationCase: EvaluationCase;
  readonly task: Readonly<Record<string, unknown>>;
}): Promise<AgentEvaluationResult> {
  const common = {
    ...input.task,
    cwd: input.cwd,
    config: input.config,
    runtime: input.runtime,
    runId: input.runId,
  };
  if (
    input.evaluationCase.role === "standardsReview" ||
    input.evaluationCase.role === "specReview"
  ) {
    return input.agent.review({
      ...common,
      kind: "pull-request",
      axis:
        input.evaluationCase.role === "standardsReview" ? "standards" : "spec",
    } as Parameters<SandcastleCodexRunner["review"]>[0]);
  }
  if (input.evaluationCase.role === "repairVerification") {
    return input.agent.verifyRepair(
      common as Parameters<SandcastleCodexRunner["verifyRepair"]>[0]
    );
  }
  const kind =
    input.evaluationCase.role === "validationRepair"
      ? "pull-request"
      : input.evaluationCase.role === "ciRepair"
        ? "ci-failure"
        : input.evaluationCase.role === "mergeStateRepair"
          ? "merge-state"
          : "restack-conflict";
  return input.agent.repair({
    ...common,
    kind,
  } as Parameters<SandcastleCodexRunner["repair"]>[0]);
}

async function candidateResult(input: {
  readonly commandRunner: CommandRunner;
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runtime: Awaited<ReturnType<DeclaredRuntimeProvider["prepare"]>>;
  readonly runId: string;
  readonly evaluationCase: EvaluationCase;
  readonly agentResult: AgentEvaluationResult;
}): Promise<CandidateCaseResult> {
  if (input.evaluationCase.gold.kind === "review") {
    const report = input.agentResult as ReviewReport;
    return {
      kind: "review",
      structuredOutputValid: true,
      findings: report.findings.map(candidateFinding),
    };
  }
  if (input.evaluationCase.gold.kind === "repairVerification") {
    const report = input.agentResult as RepairVerificationReport;
    return {
      kind: "repairVerification",
      structuredOutputValid: true,
      resolvedFindingIds: report.resolvedFindingIds,
      findings: report.findings.map(candidateFinding),
    };
  }
  const checks = input.evaluationCase.execution.mutationChecks;
  if (!checks) {
    throw new Error(
      `Mutation case ${input.evaluationCase.id} is missing mutationChecks.`
    );
  }
  const branch = branchForTask(input.evaluationCase.execution.task);
  const verification = await new DockerVerificationRunner(
    input.commandRunner
  ).verify({
    cwd: input.cwd,
    runId: input.runId,
    label: `${input.evaluationCase.id}-declared`,
    ref: branch,
    config: input.config,
    runtime: input.runtime,
    extraCommands: checks.verificationCommands.map((command, index) =>
      sandboxCommand(`Evaluation verification ${index + 1}`, command)
    ),
  });
  const cause = await new DockerVerificationRunner(input.commandRunner).verify({
    cwd: input.cwd,
    runId: input.runId,
    label: `${input.evaluationCase.id}-cause`,
    ref: branch,
    config: input.config,
    runtime: input.runtime,
    extraCommands: [
      sandboxCommand(
        "Evaluation intended-cause oracle",
        checks.intendedCauseCommand
      ),
    ],
  });
  const gate = checks.gateIntegrityCommand
    ? await new DockerVerificationRunner(input.commandRunner).verify({
        cwd: input.cwd,
        runId: input.runId,
        label: `${input.evaluationCase.id}-gate`,
        ref: branch,
        config: input.config,
        runtime: input.runtime,
        extraCommands: [
          sandboxCommand(
            "Evaluation gate-integrity oracle",
            checks.gateIntegrityCommand
          ),
        ],
      })
    : undefined;
  if (
    verification.status === "infra_failed" ||
    cause.status === "infra_failed" ||
    gate?.status === "infra_failed"
  ) {
    throw new PostAgentInfrastructureError(
      `Evaluation verification infrastructure failed for ${input.evaluationCase.id}.`,
      input.agentResult.invocation
    );
  }
  const scopeRespected = await allowedScope({
    commandRunner: input.commandRunner,
    cwd: input.cwd,
    baseRef: input.evaluationCase.execution.baseRef,
    branch,
    patterns: checks.allowedPathPatterns,
  });
  return {
    kind: "mutation",
    structuredOutputValid: true,
    intendedCauseAddressed: cause.status === "passed",
    verificationPassed: verification.status === "passed",
    scopeRespected,
    gateIntegrityPreserved: gate?.status !== "failed",
    unauthorizedMutation: !scopeRespected,
    verificationRegression: verification.status === "failed",
  };
}

export async function retryPreAgentInfrastructure<T>(
  operation: (retryCount: number) => Promise<T>
): Promise<T> {
  try {
    return await operation(0);
  } catch (error) {
    if (!(error instanceof AgentInfrastructureError)) throw error;
    try {
      return await operation(1);
    } catch (retryError) {
      if (retryError instanceof AgentInfrastructureError) {
        throw new PreAgentInfrastructureExhaustedError(retryError);
      }
      throw retryError;
    }
  }
}

class PreAgentInfrastructureExhaustedError extends Error {
  constructor(readonly cause: AgentInfrastructureError) {
    super(cause.message);
    this.name = "PreAgentInfrastructureExhaustedError";
  }
}

class PostAgentInfrastructureError extends Error {
  constructor(
    message: string,
    readonly invocation?: AgentInvocationMetrics
  ) {
    super(message);
    this.name = "PostAgentInfrastructureError";
  }
}

async function materializeCase(
  runner: CommandRunner,
  evaluationCase: EvaluationCase,
  cwd: string
): Promise<void> {
  await mustRun(
    runner,
    "git",
    [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      evaluationCase.execution.repositoryPath,
      cwd,
    ],
    { timeoutMs: 5 * 60 * 1000 }
  );
  if (
    !evaluationCase.execution.headRef.startsWith(
      evaluationCase.source.commit
    ) &&
    !evaluationCase.source.commit.startsWith(evaluationCase.execution.headRef)
  ) {
    throw new CorpusMaterializationError(
      `Case ${evaluationCase.id} source commit does not match its head ref.`
    );
  }
  if (evaluationCase.source.patchDigest) {
    const patch = await mustRun(
      runner,
      "git",
      [
        "diff",
        "--binary",
        `${evaluationCase.execution.baseRef}...${evaluationCase.execution.headRef}`,
      ],
      { cwd }
    );
    const digest = stableDigest(patch.stdout);
    if (digest !== evaluationCase.source.patchDigest) {
      throw new CorpusMaterializationError(
        `Case ${evaluationCase.id} patch digest changed: expected ${evaluationCase.source.patchDigest}, received ${digest}.`
      );
    }
  }
  const task = evaluationCase.execution.task;
  const baseBranch = requiredTaskString(task, "baseBranch");
  const branch = branchForTask(task);
  await mustRun(
    runner,
    "git",
    [
      "update-ref",
      `refs/remotes/origin/${baseBranch}`,
      evaluationCase.execution.baseRef,
    ],
    { cwd }
  );
  await mustRun(
    runner,
    "git",
    [
      "update-ref",
      `refs/remotes/origin/${branch}`,
      evaluationCase.execution.headRef,
    ],
    { cwd }
  );
  await mustRun(
    runner,
    "git",
    ["branch", "--force", branch, evaluationCase.execution.headRef],
    { cwd }
  );
}

class CorpusMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusMaterializationError";
  }
}

function evaluationConfig(
  evaluationCase: EvaluationCase,
  profile: EvaluationProfile
): AgentTrainConfig {
  const config = evaluationCase.execution.config as unknown as AgentTrainConfig;
  if (!config.agentProfiles || !config.validation || !config.docker) {
    throw new Error(
      `Evaluation case ${evaluationCase.id} has an incomplete AgentTrainConfig.`
    );
  }
  return {
    ...config,
    agentProfiles: {
      ...config.agentProfiles,
      [evaluationCase.role]: profile,
    },
  };
}

function candidateFinding(
  finding: ReviewReport["findings"][number]
): CandidateFinding {
  return {
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    path: finding.path,
    rule: finding.rule,
    evidence: finding.evidence,
  };
}

function malformedCandidateResult(
  evaluationCase: EvaluationCase
): CandidateCaseResult {
  if (evaluationCase.gold.kind === "review") {
    return {
      kind: "review",
      structuredOutputValid: false,
      findings: [],
    };
  }
  if (evaluationCase.gold.kind === "repairVerification") {
    return {
      kind: "repairVerification",
      structuredOutputValid: false,
      resolvedFindingIds: [],
      findings: [],
    };
  }
  return {
    kind: "mutation",
    structuredOutputValid: false,
    intendedCauseAddressed: false,
    verificationPassed: false,
    scopeRespected: false,
    gateIntegrityPreserved: false,
    unauthorizedMutation: false,
    verificationRegression: false,
  };
}

function branchForTask(task: Readonly<Record<string, unknown>>): string {
  return requiredTaskString(task, "branch");
}

function requiredTaskString(
  task: Readonly<Record<string, unknown>>,
  key: string
): string {
  const value = task[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Evaluation task requires a non-empty ${key}.`);
  }
  return value;
}

function sandboxCommand(name: string, command: string): SandboxCommandConfig {
  return { name, command, timeoutMs: 15 * 60 * 1000 };
}

async function allowedScope(input: {
  readonly commandRunner: CommandRunner;
  readonly cwd: string;
  readonly baseRef: string;
  readonly branch: string;
  readonly patterns: readonly string[];
}): Promise<boolean> {
  const changed = await input.commandRunner.run(
    "git",
    ["diff", "--name-only", `${input.baseRef}...${input.branch}`],
    { cwd: input.cwd }
  );
  if (changed.exitCode !== 0) return false;
  const matchers = input.patterns.map((pattern) => new RegExp(pattern, "u"));
  return changed.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .every((path) => matchers.some((matcher) => matcher.test(path)));
}
