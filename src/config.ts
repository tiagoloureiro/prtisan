import { z } from "zod";

import { pathExists, readJson } from "./fs.js";
import { resolvePath } from "./path.js";
import type { AgentTrainConfig } from "./types.js";

const ReasoningSchema = z.enum(["low", "medium", "high", "xhigh"]);
const SessionPolicySchema = z.enum(["none", "failures", "all"]);
const DEFAULT_MODELS = {
  repair: "gpt-5.6-sol",
  review: "gpt-5.6-sol",
};
const DEFAULT_REASONING = {
  repair: "medium",
  review: "low",
} satisfies AgentTrainConfig["reasoning"];
const DEFAULT_CONCURRENCY = {
  validate: 4,
  github: 4,
};
const DEFAULT_DOCKER = {
  imageName: "prtisan:repository",
  imagePolicy: "managed",
  dockerfile: ".prtisan/Dockerfile",
  context: ".",
  codexHome: "prtisan://codex-home",
  cpus: 2,
  mounts: [],
} satisfies AgentTrainConfig["docker"];
const DEFAULT_RUNTIME = {
  autoProvision: true,
  verificationMode: "auto",
  probes: [],
  verification: [],
} satisfies AgentTrainConfig["runtime"];
const DEFAULT_VALIDATION = {
  maxRepairRounds: 3,
  maxAgentRunsPerHead: 4,
  maxWallTimeMs: 30 * 60 * 1000,
  promptCharBudget: 32_000,
  maxCheckLogChars: 8_000,
  maxCheckEvidenceChars: 16_000,
  checkStartTimeoutMs: 2 * 60 * 1000,
  checkCompletionTimeoutMs: 15 * 60 * 1000,
  leaseTtlMs: 2 * 60 * 60 * 1000,
  cacheTtlDays: 14,
} satisfies AgentTrainConfig["validation"];
const DEFAULT_RETENTION = {
  ttlDays: 14,
  maxLogBytes: 10 * 1024 * 1024,
  keepSessions: true,
  sessionPolicy: "failures",
  maxRuns: 50,
  maxTotalBytes: 512 * 1024 * 1024,
} satisfies AgentTrainConfig["retention"];

const SandboxCommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
  env: z.record(z.string(), z.string()).optional(),
});

const ConfigSchema = z.object({
  repo: z.string().min(1),
  targetBranch: z.string().min(1).default("main"),
  remote: z.string().min(1).default("origin"),
  models: z
    .object({
      repair: z.string().min(1).default(DEFAULT_MODELS.repair),
      review: z.string().min(1).default(DEFAULT_MODELS.review),
    })
    .default(DEFAULT_MODELS),
  reasoning: z
    .object({
      repair: ReasoningSchema.default(DEFAULT_REASONING.repair),
      review: ReasoningSchema.default(DEFAULT_REASONING.review),
    })
    .default(DEFAULT_REASONING),
  concurrency: z
    .object({
      validate: z
        .number()
        .int()
        .positive()
        .max(32)
        .default(DEFAULT_CONCURRENCY.validate),
      github: z
        .number()
        .int()
        .positive()
        .max(16)
        .default(DEFAULT_CONCURRENCY.github),
    })
    .default(DEFAULT_CONCURRENCY),
  docker: z
    .object({
      imageName: z.string().min(1).default(DEFAULT_DOCKER.imageName),
      imagePolicy: z
        .enum(["managed", "external"])
        .default(DEFAULT_DOCKER.imagePolicy),
      dockerfile: z.string().min(1).default(DEFAULT_DOCKER.dockerfile),
      context: z.string().min(1).default(DEFAULT_DOCKER.context),
      codexHome: z.string().min(1).default(DEFAULT_DOCKER.codexHome),
      cpus: z.number().positive().optional(),
      mounts: z
        .array(
          z.object({
            hostPath: z.string().min(1),
            sandboxPath: z.string().min(1),
            readonly: z.boolean().optional(),
          })
        )
        .default([]),
    })
    .default(DEFAULT_DOCKER),
  runtime: z
    .object({
      autoProvision: z.boolean().default(DEFAULT_RUNTIME.autoProvision),
      verificationMode: z
        .enum(["auto", "explicit"])
        .default(DEFAULT_RUNTIME.verificationMode),
      probes: z.array(SandboxCommandSchema).default([]),
      bootstrap: SandboxCommandSchema.optional(),
      verification: z.array(SandboxCommandSchema).default([]),
    })
    .default(DEFAULT_RUNTIME),
  validation: z
    .object({
      maxRepairRounds: z
        .number()
        .int()
        .min(0)
        .max(DEFAULT_VALIDATION.maxRepairRounds)
        .default(DEFAULT_VALIDATION.maxRepairRounds),
      maxAgentRunsPerHead: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_VALIDATION.maxAgentRunsPerHead)
        .default(DEFAULT_VALIDATION.maxAgentRunsPerHead),
      maxWallTimeMs: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_VALIDATION.maxWallTimeMs)
        .default(DEFAULT_VALIDATION.maxWallTimeMs),
      promptCharBudget: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_VALIDATION.promptCharBudget)
        .default(DEFAULT_VALIDATION.promptCharBudget),
      maxCheckLogChars: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_VALIDATION.maxCheckLogChars)
        .default(DEFAULT_VALIDATION.maxCheckLogChars),
      maxCheckEvidenceChars: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_VALIDATION.maxCheckEvidenceChars)
        .default(DEFAULT_VALIDATION.maxCheckEvidenceChars),
      checkStartTimeoutMs: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_VALIDATION.checkStartTimeoutMs)
        .default(DEFAULT_VALIDATION.checkStartTimeoutMs),
      checkCompletionTimeoutMs: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_VALIDATION.checkCompletionTimeoutMs)
        .default(DEFAULT_VALIDATION.checkCompletionTimeoutMs),
      leaseTtlMs: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_VALIDATION.leaseTtlMs),
      cacheTtlDays: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_VALIDATION.cacheTtlDays),
    })
    .default(DEFAULT_VALIDATION),
  retention: z
    .object({
      ttlDays: z.number().int().positive().default(DEFAULT_RETENTION.ttlDays),
      maxLogBytes: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_RETENTION.maxLogBytes),
      keepSessions: z.boolean().optional(),
      sessionPolicy: SessionPolicySchema.optional(),
      maxRuns: z.number().int().positive().default(DEFAULT_RETENTION.maxRuns),
      maxTotalBytes: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_RETENTION.maxTotalBytes),
    })
    .default(DEFAULT_RETENTION)
    .transform((value) => {
      const sessionPolicy =
        value.sessionPolicy ??
        (value.keepSessions === false
          ? "none"
          : DEFAULT_RETENTION.sessionPolicy);
      return {
        ...value,
        keepSessions: sessionPolicy !== "none",
        sessionPolicy,
      };
    }),
});

export const DEFAULT_CONFIG_PATH = ".prtisan/legacy-config.json";

export interface ConfigOverrides {
  readonly repo?: string;
  readonly targetBranch?: string;
}

export function defaultConfig(input: {
  readonly repo: string;
  readonly targetBranch: string;
}): AgentTrainConfig {
  return {
    repo: input.repo,
    targetBranch: input.targetBranch,
    remote: "origin",
    models: { ...DEFAULT_MODELS },
    reasoning: { ...DEFAULT_REASONING },
    concurrency: { ...DEFAULT_CONCURRENCY },
    docker: {
      ...DEFAULT_DOCKER,
      mounts: [...DEFAULT_DOCKER.mounts],
    },
    runtime: {
      ...DEFAULT_RUNTIME,
      probes: [...DEFAULT_RUNTIME.probes],
      verification: [...DEFAULT_RUNTIME.verification],
    },
    validation: { ...DEFAULT_VALIDATION },
    retention: { ...DEFAULT_RETENTION },
  };
}

export async function loadConfig(
  cwd: string,
  configPath = DEFAULT_CONFIG_PATH,
  overrides: ConfigOverrides = {}
): Promise<AgentTrainConfig> {
  const resolvedPath = resolvePath(cwd, configPath);
  const rawConfig = (await pathExists(resolvedPath))
    ? await readJson<unknown>(resolvedPath)
    : overrides.repo
      ? { repo: overrides.repo, targetBranch: overrides.targetBranch }
      : undefined;

  if (!rawConfig) {
    throw new Error(`Missing legacy Prtisan config at ${resolvedPath}`);
  }

  const parsed = ConfigSchema.parse({
    ...objectConfig(rawConfig),
    ...definedOverrides(overrides),
  });
  if (parsed.repo === "OWNER/REPO") {
    throw new Error(`Configure "repo" in ${resolvedPath}.`);
  }

  return parsed;
}

function definedOverrides(overrides: ConfigOverrides): Record<string, string> {
  return Object.fromEntries(
    Object.entries(overrides).filter((entry): entry is [string, string] =>
      Boolean(entry[1])
    )
  );
}

function objectConfig(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected config JSON object.");
  }
  return value as Record<string, unknown>;
}
