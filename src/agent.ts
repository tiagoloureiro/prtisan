import { unlink } from "node:fs/promises";
import { z } from "zod";

import { issueReviewSandboxBranch, reviewSandboxBranch } from "./branching.js";
import { BunCommandRunner, type CommandRunner } from "./exec.js";
import { ensureDir, pathExists, readText, writeText } from "./fs.js";
import { joinPath, resolvePath } from "./path.js";
import {
  buildCiRepairPrompt,
  buildIssueBranchRepairPrompt,
  buildIssueBranchReviewPrompt,
  buildMergeStateRepairPrompt,
  buildRepairPrompt,
  buildRepairVerificationPrompt,
  buildRestackConflictRepairPrompt,
  buildReviewPrompt,
} from "./prompts.js";
import {
  prtisanRepositoryDataPath,
  resolveCodexHome,
} from "./prtisan-paths.js";
import type { PreparedRuntime } from "./runtime.js";
import type {
  AgentRunOutcome,
  AgentTrainConfig,
  Issue,
  PullRequestCheckEvidence,
  ReasoningEffort,
  RepairVerificationReport,
  ReviewAxis,
  ReviewFinding,
  ReviewReport,
} from "./types.js";
import { isHighRiskPath } from "./validation-hardening.js";

const SANDBOX_CODEX_HOME = "/home/agent/.codex-prtisan";
const ReviewOutputSchema = z.object({
  axis: z.enum(["standards", "spec"]).optional(),
  summary: z.string().default(""),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocking", "advisory"]).default("blocking"),
        title: z.string().default("Review finding"),
        body: z.string().default(""),
        rule: z.string().optional(),
        evidence: z.string().optional(),
        path: z.string().optional(),
        line: z.number().int().positive().optional(),
        side: z.enum(["RIGHT", "LEFT"]).optional(),
      })
    )
    .default([]),
});
const RepairOutputSchema = z.object({
  addressedFindingIds: z.array(z.string()).default([]),
  changedPaths: z.array(z.string()).default([]),
  summary: z.string().default(""),
  limitations: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z.array(z.string()).default([])
  ),
});
const RepairVerificationOutputSchema = z.object({
  summary: z.string().default(""),
  resolvedFindingIds: z.array(z.string()).default([]),
  findings: ReviewOutputSchema.shape.findings,
});

export class AgentOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentOutputError";
  }
}

export class AgentPromptBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPromptBudgetError";
  }
}

export class AgentInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentInfrastructureError";
  }
}

export class AgentExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentExecutionError";
  }
}

export interface ReviewPullRequestInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runId: string;
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly diff: string;
  readonly axis: ReviewAxis;
  readonly baseRefOid?: string;
  readonly headRefOid?: string;
  readonly changedFiles?: readonly string[];
  readonly effort?: ReasoningEffort;
  readonly runtime?: PreparedRuntime;
}

export interface RepairPullRequestInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runId: string;
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly findings: readonly ReviewFinding[];
  readonly runtime?: PreparedRuntime;
}

export interface RepairCiFailureInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runId: string;
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly checkEvidence: readonly PullRequestCheckEvidence[];
  readonly runtime?: PreparedRuntime;
}

export interface RepairMergeStateInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runId: string;
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly mergeState: string;
  readonly blockers: readonly string[];
  readonly runtime?: PreparedRuntime;
}

export interface RepairRestackConflictInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runId: string;
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly parentContract: string;
  readonly childContract: string;
  readonly uniqueDiff: string;
  readonly runtime?: PreparedRuntime;
}

export interface ReviewIssueBranchInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runId: string;
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly targetBranch: string;
  readonly runtime?: PreparedRuntime;
}

export interface RepairIssueBranchInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runId: string;
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly branch: string;
  readonly targetBranch: string;
  readonly findings: readonly ReviewFinding[];
  readonly runtime?: PreparedRuntime;
}

export interface VerifyRepairInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runId: string;
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseRefOid: string;
  readonly repairedHeadRefOid: string;
  readonly findings: readonly ReviewFinding[];
  readonly runtime?: PreparedRuntime;
}

export type AgentReviewTask =
  | ({ readonly kind: "pull-request" } & ReviewPullRequestInput)
  | ({ readonly kind: "issue-branch" } & ReviewIssueBranchInput);

export type AgentRepairTask =
  | ({ readonly kind: "pull-request" } & RepairPullRequestInput)
  | ({ readonly kind: "ci-failure" } & RepairCiFailureInput)
  | ({ readonly kind: "merge-state" } & RepairMergeStateInput)
  | ({ readonly kind: "restack-conflict" } & RepairRestackConflictInput)
  | ({ readonly kind: "issue-branch" } & RepairIssueBranchInput);

export interface AgentRunner {
  review(input: AgentReviewTask): Promise<ReviewReport>;
  repair(input: AgentRepairTask): Promise<AgentRunOutcome>;
  verifyRepair?(input: VerifyRepairInput): Promise<RepairVerificationReport>;
}

export class SandcastleCodexRunner implements AgentRunner {
  constructor(
    private readonly runner: CommandRunner = new BunCommandRunner()
  ) {}

  async review(input: AgentReviewTask): Promise<ReviewReport> {
    const run =
      input.kind === "pull-request"
        ? {
            branch: reviewSandboxBranch(input.prNumber, input.axis),
            baseBranch: input.branch,
            name: `review-${input.axis}-${input.prNumber}`,
            prompt: buildReviewPrompt(input),
            axis: input.axis,
          }
        : {
            branch: issueReviewSandboxBranch(input.issue.number),
            baseBranch: input.targetBranch,
            name: `review-spec-issue-${input.issue.number}`,
            prompt: buildIssueBranchReviewPrompt(input),
            axis: "spec" as const,
          };

    const result = await this.runCodex({
      cwd: input.cwd,
      config: input.config,
      runId: input.runId,
      branch: run.branch,
      baseBranch: run.baseBranch,
      name: run.name,
      model: input.config.models.review,
      effort: input.kind === "pull-request" ? (input.effort ?? "low") : "low",
      runtime: input.runtime,
      prompt: run.prompt,
      maxIterations: 1,
      cleanupBranch: true,
      structuredOutput: {
        tag: "review",
        schema: ReviewOutputSchema,
        maxRetries: 1,
      },
    });

    return {
      ...parseReviewReport(result.structuredOutput ?? result.stdout, run.axis),
      promptChars: result.promptChars,
      durationMs: result.durationMs,
    };
  }

  async repair(input: AgentRepairTask): Promise<AgentRunOutcome> {
    if (input.kind === "pull-request") {
      return this.runCodex({
        cwd: input.cwd,
        config: input.config,
        runId: input.runId,
        branch: input.branch,
        baseBranch: input.baseBranch,
        name: `repair-${input.prNumber}`,
        model: input.config.models.repair,
        effort: input.config.reasoning.repair,
        runtime: input.runtime,
        prompt: buildRepairPrompt(input),
        maxIterations: 1,
        structuredOutput: {
          tag: "repair",
          schema: RepairOutputSchema,
          maxRetries: 1,
        },
      });
    }

    if (input.kind === "ci-failure") {
      return this.runCodex({
        cwd: input.cwd,
        config: input.config,
        runId: input.runId,
        branch: input.branch,
        baseBranch: input.baseBranch,
        name: `repair-ci-${input.prNumber}`,
        model: input.config.models.repair,
        effort: input.config.reasoning.repair,
        runtime: input.runtime,
        prompt: buildCiRepairPrompt(input),
        maxIterations: 1,
        structuredOutput: {
          tag: "repair",
          schema: RepairOutputSchema,
          maxRetries: 1,
        },
      });
    }

    if (input.kind === "merge-state") {
      return this.runCodex({
        cwd: input.cwd,
        config: input.config,
        runId: input.runId,
        branch: input.branch,
        baseBranch: input.baseBranch,
        name: `repair-merge-state-${input.prNumber}`,
        model: input.config.models.repair,
        effort: input.config.reasoning.repair,
        runtime: input.runtime,
        prompt: buildMergeStateRepairPrompt(input),
        maxIterations: 1,
        structuredOutput: {
          tag: "repair",
          schema: RepairOutputSchema,
          maxRetries: 1,
        },
      });
    }

    if (input.kind === "restack-conflict") {
      return this.runCodex({
        cwd: input.cwd,
        config: input.config,
        runId: input.runId,
        branch: input.branch,
        baseBranch: input.baseBranch,
        name: `repair-restack-${input.prNumber}`,
        model: input.config.models.repair,
        effort: input.config.reasoning.repair,
        runtime: input.runtime,
        prompt: buildRestackConflictRepairPrompt(input),
        maxIterations: 1,
        structuredOutput: {
          tag: "repair",
          schema: RepairOutputSchema,
          maxRetries: 1,
        },
      });
    }

    return this.runCodex({
      cwd: input.cwd,
      config: input.config,
      runId: input.runId,
      branch: input.branch,
      baseBranch: input.targetBranch,
      name: `repair-issue-${input.issue.number}`,
      model: input.config.models.repair,
      effort: input.config.reasoning.repair,
      runtime: input.runtime,
      prompt: buildIssueBranchRepairPrompt(input),
      maxIterations: 1,
      structuredOutput: {
        tag: "repair",
        schema: RepairOutputSchema,
        maxRetries: 1,
      },
    });
  }

  async verifyRepair(
    input: VerifyRepairInput
  ): Promise<RepairVerificationReport> {
    const branch = reviewSandboxBranch(input.prNumber, "spec");
    const prompt = buildRepairVerificationPrompt(input);
    const result = await this.runCodex({
      cwd: input.cwd,
      config: input.config,
      runId: input.runId,
      branch,
      baseBranch: input.branch,
      baseRef: input.repairedHeadRefOid,
      name: `verify-repair-${input.prNumber}`,
      model: input.config.models.review,
      effort: input.findings.some((finding) =>
        isHighRiskPath(finding.path ?? "")
      )
        ? "medium"
        : "low",
      runtime: input.runtime,
      prompt,
      maxIterations: 1,
      cleanupBranch: true,
      structuredOutput: {
        tag: "repair-verification",
        schema: RepairVerificationOutputSchema,
        maxRetries: 1,
      },
    });
    return {
      ...parseRepairVerificationReport(
        result.structuredOutput ?? result.stdout
      ),
      promptChars: result.promptChars,
      durationMs: result.durationMs,
    };
  }

  private async runCodex(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly runId: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly baseRef?: string;
    readonly name: string;
    readonly model: string;
    readonly effort: ReasoningEffort;
    readonly runtime?: PreparedRuntime;
    readonly prompt: string;
    readonly maxIterations: number;
    readonly cleanupBranch?: boolean;
    readonly structuredOutput?: {
      readonly tag: string;
      readonly schema: unknown;
      readonly maxRetries: number;
    };
  }): Promise<AgentRunOutcome> {
    if (input.prompt.length > input.config.validation.promptCharBudget) {
      throw new AgentPromptBudgetError(
        `Agent prompt ${input.name} is ${input.prompt.length} characters, exceeding the ${input.config.validation.promptCharBudget} character budget.`
      );
    }
    const codexHome = await prepareCodexHome(input.cwd, input.config);
    const logPath = joinPath(
      prtisanRepositoryDataPath(input.cwd, "runs", input.runId),
      "logs",
      `${input.name}-${Date.now()}.log`
    );
    await ensureDir(
      prtisanRepositoryDataPath(input.cwd, "runs", input.runId, "logs")
    );

    const sandcastle = await import("@ai-hero/sandcastle");
    const sandboxes = await import("@ai-hero/sandcastle/sandboxes/docker");

    const mounts = [
      {
        hostPath: codexHome,
        sandboxPath: SANDBOX_CODEX_HOME,
      },
      ...input.config.docker.mounts.map((mount) => ({
        ...mount,
        hostPath: resolvePath(input.cwd, mount.hostPath),
      })),
      ...(input.runtime?.cacheMount ? [input.runtime.cacheMount] : []),
    ];
    const hostSessionsDir = joinPath(codexHome, "sessions");
    const sandboxSessionsDir = joinPath(SANDBOX_CODEX_HOME, "sessions");

    const output = input.structuredOutput
      ? sandcastle.Output.object({
          tag: input.structuredOutput.tag,
          schema: input.structuredOutput.schema,
          maxRetries: input.structuredOutput.maxRetries,
        })
      : undefined;
    const branchHeadBeforeRun = input.cleanupBranch
      ? undefined
      : await resolveLocalBranchHead(this.runner, input.cwd, input.branch);

    const startedAt = Date.now();
    let result;
    try {
      result = await sandcastle.run({
        cwd: input.cwd,
        branchStrategy: {
          type: "branch",
          branch: input.branch,
          baseBranch:
            input.baseRef ?? `${input.config.remote}/${input.baseBranch}`,
        },
        sandbox: sandboxes.docker({
          imageName: input.runtime?.imageName ?? input.config.docker.imageName,
          mounts,
          cpus: input.config.docker.cpus,
        }),
        agent: sandcastle.codex(input.model, {
          effort: input.effort,
          captureSessions: input.config.retention.keepSessions,
          env: {
            CODEX_HOME: SANDBOX_CODEX_HOME,
          },
          sessionStorage: {
            hostSessionsDir,
            sandboxSessionsDir,
          },
        }),
        hooks: input.runtime?.bootstrap
          ? {
              sandbox: {
                onSandboxReady: [
                  {
                    command: input.runtime.bootstrap.command,
                    timeoutMs: Math.min(
                      input.runtime.bootstrap.timeoutMs,
                      input.config.validation.maxWallTimeMs
                    ),
                  },
                ],
              },
            }
          : undefined,
        prompt: input.prompt,
        maxIterations: input.maxIterations,
        name: input.name,
        completionSignal: "<promise>COMPLETE</promise>",
        logging: {
          type: "file",
          path: logPath,
        },
        idleTimeoutSeconds: Math.ceil(
          input.config.validation.maxWallTimeMs / 1000
        ),
        timeouts: {
          gitSetupMs: 60_000,
          commitCollectionMs: 120_000,
          mergeToHostMs: 120_000,
        },
        output,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isPreAgentInfrastructureFailure(message)) {
        throw new AgentInfrastructureError(message, { cause: error });
      }
      throw new AgentExecutionError(message, { cause: error });
    } finally {
      if (input.cleanupBranch) {
        await this.runner.run("git", ["branch", "-D", input.branch], {
          cwd: input.cwd,
        });
      }
    }

    const structuredOutput = "output" in result ? result.output : undefined;
    const iteration = result.iterations?.at?.(-1);
    const reportedCommits = Array.isArray(result.commits)
      ? result.commits
          .map((commit: { sha?: string }) => commit.sha)
          .filter(
            (sha: string | undefined): sha is string =>
              typeof sha === "string" && sha.length > 0
          )
      : [];
    const commits = branchHeadBeforeRun
      ? await reconcileRunCommits({
          runner: this.runner,
          cwd: input.cwd,
          branch: input.branch,
          branchHeadBeforeRun,
          reportedCommits,
        })
      : reportedCommits;
    if (
      input.config.retention.sessionPolicy === "failures" &&
      iteration?.sessionFilePath
    ) {
      await unlink(iteration.sessionFilePath).catch(() => undefined);
    }

    return {
      branch: result.branch ?? input.branch,
      commits,
      stdout: String(result.stdout ?? ""),
      structuredOutput,
      logFilePath: result.logFilePath ?? logPath,
      sessionId:
        input.config.retention.sessionPolicy === "all"
          ? iteration?.sessionId
          : undefined,
      promptChars: input.prompt.length,
      durationMs: Date.now() - startedAt,
      usage: iteration?.usage,
    };
  }
}

async function resolveLocalBranchHead(
  runner: CommandRunner,
  cwd: string,
  branch: string
): Promise<string | undefined> {
  try {
    const result = await runner.run(
      "git",
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      { cwd }
    );
    const sha = result.stdout.trim();
    return result.exitCode === 0 && sha ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function reconcileRunCommits(input: {
  readonly runner: CommandRunner;
  readonly cwd: string;
  readonly branch: string;
  readonly branchHeadBeforeRun: string;
  readonly reportedCommits: readonly string[];
}): Promise<readonly string[]> {
  try {
    const result = await input.runner.run(
      "git",
      [
        "rev-list",
        "--reverse",
        `${input.branchHeadBeforeRun}..refs/heads/${input.branch}`,
      ],
      { cwd: input.cwd }
    );
    if (result.exitCode !== 0) return input.reportedCommits;

    const observedCommits = result.stdout
      .split(/\r?\n/)
      .map((sha) => sha.trim())
      .filter(Boolean);
    return observedCommits.length > 0 ? observedCommits : input.reportedCommits;
  } catch {
    return input.reportedCommits;
  }
}

function isPreAgentInfrastructureFailure(message: string): boolean {
  return /bootstrap|onSandboxReady|sandbox hook|command not found|exit(?:ed)? (?:with )?(?:code )?127|cannot connect to the docker daemon|no such image|network is unreachable|could not resolve host/i.test(
    message
  );
}

export async function prepareCodexHome(
  cwd: string,
  config: AgentTrainConfig
): Promise<string> {
  const codexHome = resolveCodexHome(cwd, config.docker.codexHome);
  const skillsDir = joinPath(codexHome, "skills", "code-review");
  await ensureDir(skillsDir);
  await ensureDir(joinPath(codexHome, "sessions"));

  const skillSource = joinPath(
    import.meta.dir,
    "vendor",
    "code-review",
    "SKILL.md"
  );
  await writeText(joinPath(skillsDir, "SKILL.md"), await readText(skillSource));

  const configPath = joinPath(codexHome, "config.toml");
  if (!(await pathExists(configPath))) {
    await writeText(
      configPath,
      [
        `model = "${config.models.repair}"`,
        `model_reasoning_effort = "${config.reasoning.repair}"`,
        "",
      ].join("\n")
    );
  }

  return codexHome;
}

export function parseReviewReport(
  output: unknown,
  axis: ReviewAxis
): ReviewReport {
  if (typeof output !== "string") {
    return normalizeReviewReport(output, axis);
  }

  const jsonText = extractTaggedJson(output, "review") ?? output.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(jsonText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentOutputError(
      `Review agent did not return valid JSON for ${axis}: ${message}`,
      { cause: error }
    );
  }

  return normalizeReviewReport(parsed, axis);
}

function normalizeReviewReport(
  parsed: unknown,
  axis: ReviewAxis
): ReviewReport {
  const value =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Partial<ReviewReport>)
      : {};
  const findings = Array.isArray(value.findings)
    ? value.findings.map((finding) => normalizeFinding(finding, axis))
    : [];

  return {
    axis,
    summary: typeof value.summary === "string" ? value.summary : "",
    findings,
  };
}

function extractTaggedJson(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  return match?.[1];
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function normalizeFinding(value: unknown, axis: ReviewAxis): ReviewFinding {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const severity = record.severity === "advisory" ? "advisory" : "blocking";
  return {
    axis,
    severity,
    title: typeof record.title === "string" ? record.title : "Review finding",
    body: typeof record.body === "string" ? record.body : "",
    rule: typeof record.rule === "string" ? record.rule : undefined,
    evidence: typeof record.evidence === "string" ? record.evidence : undefined,
    path: typeof record.path === "string" ? record.path : undefined,
    line: typeof record.line === "number" ? record.line : undefined,
    side:
      record.side === "LEFT"
        ? "LEFT"
        : record.side === "RIGHT"
          ? "RIGHT"
          : undefined,
  };
}

export function parseRepairVerificationReport(
  output: unknown
): RepairVerificationReport {
  const parsed =
    typeof output === "string"
      ? parseTaggedJson(output, "repair-verification")
      : output;
  const value =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    summary: typeof value.summary === "string" ? value.summary : "",
    resolvedFindingIds: Array.isArray(value.resolvedFindingIds)
      ? value.resolvedFindingIds.filter(
          (item): item is string => typeof item === "string"
        )
      : [],
    findings: Array.isArray(value.findings)
      ? value.findings.map((finding) =>
          normalizeFinding(
            finding,
            typeof finding === "object" &&
              finding !== null &&
              (finding as Record<string, unknown>).axis === "standards"
              ? "standards"
              : "spec"
          )
        )
      : [],
  };
}

function parseTaggedJson(output: string, tag: string): unknown {
  const jsonText = extractTaggedJson(output, tag) ?? output.trim();
  try {
    return JSON.parse(stripJsonFence(jsonText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentOutputError(
      `Agent did not return valid ${tag} JSON: ${message}`,
      {
        cause: error,
      }
    );
  }
}
