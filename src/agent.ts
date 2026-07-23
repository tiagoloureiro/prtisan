import type {
  AgentRunOutcome,
  AgentTrainConfig,
  Issue,
  ReasoningEffort,
  ReviewAxis,
  ReviewFinding,
  ReviewReport,
} from "./types.js";
import {
  buildImplementPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
} from "./prompts.js";
import { ensureDir, pathExists, readText, writeText } from "./fs.js";
import { joinPath, resolvePath } from "./path.js";
import { z } from "zod";
import { reviewSandboxBranch } from "./branching.js";

const SANDBOX_CODEX_HOME = "/home/agent/.codex-agent-train";
const ReviewOutputSchema = z.object({
  axis: z.enum(["standards", "spec"]).optional(),
  summary: z.string().default(""),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocking", "advisory"]).default("blocking"),
        title: z.string().default("Review finding"),
        body: z.string().default(""),
        path: z.string().optional(),
        line: z.number().int().positive().optional(),
        side: z.enum(["RIGHT", "LEFT"]).optional(),
      }),
    )
    .default([]),
});

export interface ImplementIssueInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly trainId: string;
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly targetBranch: string;
  readonly baseBranch: string;
  readonly branch: string;
}

export interface ReviewPullRequestInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly trainId: string;
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly diff: string;
  readonly axis: ReviewAxis;
}

export interface RepairPullRequestInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly trainId: string;
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly branch: string;
  readonly baseBranch: string;
  readonly findings: readonly ReviewFinding[];
}

export interface AgentRunner {
  implementIssue(input: ImplementIssueInput): Promise<AgentRunOutcome>;
  reviewPullRequest(input: ReviewPullRequestInput): Promise<ReviewReport>;
  repairPullRequest(input: RepairPullRequestInput): Promise<AgentRunOutcome>;
}

export class SandcastleCodexRunner implements AgentRunner {
  async implementIssue(input: ImplementIssueInput): Promise<AgentRunOutcome> {
    return this.runCodex({
      cwd: input.cwd,
      config: input.config,
      trainId: input.trainId,
      branch: input.branch,
      baseBranch: input.baseBranch,
      name: `implement-${input.issue.number}`,
      model: input.config.models.implementation,
      effort: input.config.reasoning.implementation,
      prompt: buildImplementPrompt(input),
      maxIterations: 5,
    });
  }

  async reviewPullRequest(input: ReviewPullRequestInput): Promise<ReviewReport> {
    const result = await this.runCodex({
      cwd: input.cwd,
      config: input.config,
      trainId: input.trainId,
      branch: reviewSandboxBranch(input.config, input.trainId, input.prNumber, input.axis),
      baseBranch: input.branch,
      name: `review-${input.axis}-${input.prNumber}`,
      model: input.config.models.review,
      effort: input.config.reasoning.review,
      prompt: buildReviewPrompt(input),
      maxIterations: 1,
      structuredOutput: {
        tag: "review",
        schema: ReviewOutputSchema,
        maxRetries: 2,
      },
    });

    return parseReviewReport(result.structuredOutput ?? result.stdout, input.axis);
  }

  async repairPullRequest(input: RepairPullRequestInput): Promise<AgentRunOutcome> {
    return this.runCodex({
      cwd: input.cwd,
      config: input.config,
      trainId: input.trainId,
      branch: input.branch,
      baseBranch: input.baseBranch,
      name: `repair-${input.issue.number}`,
      model: input.config.models.repair,
      effort: input.config.reasoning.repair,
      prompt: buildRepairPrompt(input),
      maxIterations: 3,
    });
  }

  private async runCodex(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly trainId: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly name: string;
    readonly model: string;
    readonly effort: ReasoningEffort;
    readonly prompt: string;
    readonly maxIterations: number;
    readonly structuredOutput?: {
      readonly tag: string;
      readonly schema: unknown;
      readonly maxRetries: number;
    };
  }): Promise<AgentRunOutcome> {
    const codexHome = await prepareCodexHome(input.cwd, input.config);
    const logPath = joinPath(
      input.cwd,
      ".sandcastle",
      "trains",
      input.trainId,
      "logs",
      `${input.name}-${Date.now()}.log`,
    );
    await ensureDir(joinPath(input.cwd, ".sandcastle", "trains", input.trainId, "logs"));

    const sandcastle = (await import("@ai-hero/sandcastle")) as Record<string, any>;
    const sandboxes = (await import("@ai-hero/sandcastle/sandboxes/docker")) as Record<string, any>;

    const mounts = [
      {
        hostPath: codexHome,
        sandboxPath: SANDBOX_CODEX_HOME,
      },
      ...input.config.docker.mounts.map((mount) => ({
        ...mount,
        hostPath: resolvePath(input.cwd, mount.hostPath),
      })),
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

    const result = await sandcastle.run({
      cwd: input.cwd,
      branchStrategy: {
        type: "branch",
        branch: input.branch,
        baseBranch: `${input.config.remote}/${input.baseBranch}`,
      },
      sandbox: sandboxes.docker({
        imageName: input.config.docker.imageName,
        mounts,
        cpus: input.config.docker.cpus,
        env: {
          CODEX_HOME: SANDBOX_CODEX_HOME,
        },
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
      prompt: input.prompt,
      maxIterations: input.maxIterations,
      name: input.name,
      completionSignal: "<promise>COMPLETE</promise>",
      logging: {
        type: "file",
        path: logPath,
      },
      timeouts: {
        gitSetupMs: 60_000,
        commitCollectionMs: 120_000,
        mergeToHostMs: 120_000,
      },
      output,
    });

    return {
      branch: result.branch ?? input.branch,
      commits: Array.isArray(result.commits)
        ? result.commits
            .map((commit: { sha?: string }) => commit.sha)
            .filter((sha: string | undefined): sha is string => typeof sha === "string" && sha.length > 0)
        : [],
      stdout: String(result.stdout ?? ""),
      structuredOutput: result.output,
      logFilePath: result.logFilePath ?? logPath,
      sessionId: result.iterations?.at?.(-1)?.sessionId,
    };
  }
}

export async function prepareCodexHome(cwd: string, config: AgentTrainConfig): Promise<string> {
  const codexHome = resolvePath(cwd, config.docker.codexHome);
  const skillsDir = joinPath(codexHome, "skills", "code-review");
  await ensureDir(skillsDir);
  await ensureDir(joinPath(codexHome, "sessions"));

  const skillSource = joinPath(import.meta.dir, "vendor", "code-review", "SKILL.md");
  await writeText(joinPath(skillsDir, "SKILL.md"), await readText(skillSource));

  const configPath = joinPath(codexHome, "config.toml");
  if (!(await pathExists(configPath))) {
    await writeText(
      configPath,
      [
        `model = "${config.models.implementation}"`,
        `model_reasoning_effort = "${config.reasoning.implementation}"`,
        "",
      ].join("\n"),
    );
  }

  return codexHome;
}

export function parseReviewReport(output: unknown, axis: ReviewAxis): ReviewReport {
  if (typeof output !== "string") {
    return normalizeReviewReport(output, axis);
  }

  const jsonText = extractTaggedJson(output, "review") ?? output.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(jsonText));
  } catch (error) {
    throw new Error(`Review agent did not return valid JSON for ${axis}: ${error}`);
  }

  return normalizeReviewReport(parsed, axis);
}

function normalizeReviewReport(parsed: unknown, axis: ReviewAxis): ReviewReport {
  const value = typeof parsed === "object" && parsed !== null ? (parsed as Partial<ReviewReport>) : {};
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
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const severity = record.severity === "advisory" ? "advisory" : "blocking";
  return {
    axis,
    severity,
    title: typeof record.title === "string" ? record.title : "Review finding",
    body: typeof record.body === "string" ? record.body : "",
    path: typeof record.path === "string" ? record.path : undefined,
    line: typeof record.line === "number" ? record.line : undefined,
    side: record.side === "LEFT" ? "LEFT" : record.side === "RIGHT" ? "RIGHT" : undefined,
  };
}
