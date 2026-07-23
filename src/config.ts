import { z } from "zod";

import { pathExists, readJson } from "./fs.js";
import { resolvePath } from "./path.js";
import type { AgentTrainConfig } from "./types.js";

const ReasoningSchema = z.enum(["low", "medium", "high", "xhigh"]);
const DEFAULT_MODELS = {
  repair: "gpt-5.6-terra",
  review: "gpt-5.6-luna",
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
  imageName: "sandcastle:agent-train",
  codexHome: ".sandcastle/codex-home",
  mounts: [],
};
const DEFAULT_RETENTION = {
  ttlDays: 14,
  maxLogBytes: 10 * 1024 * 1024,
  keepSessions: true,
};

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
  retention: z
    .object({
      ttlDays: z.number().int().positive().default(DEFAULT_RETENTION.ttlDays),
      maxLogBytes: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_RETENTION.maxLogBytes),
      keepSessions: z.boolean().default(DEFAULT_RETENTION.keepSessions),
    })
    .default(DEFAULT_RETENTION),
});

export const DEFAULT_CONFIG_PATH = ".sandcastle/agent-train.config.json";

export interface ConfigOverrides {
  readonly repo?: string;
  readonly targetBranch?: string;
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
    throw new Error(`Missing agent train config at ${resolvedPath}`);
  }

  const parsed = ConfigSchema.parse({
    ...objectConfig(rawConfig),
    ...definedOverrides(overrides),
  });
  if (parsed.repo === "OWNER/REPO") {
    throw new Error(
      `Configure "repo" in ${resolvedPath} or pass --repo OWNER/REPO before running agent-train.`
    );
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
