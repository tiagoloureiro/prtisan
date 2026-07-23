import { z } from "zod";
import type { AgentTrainConfig } from "./types.js";
import { pathExists, readJson } from "./fs.js";
import { resolvePath } from "./path.js";

const ReasoningSchema = z.enum(["low", "medium", "high", "xhigh"]);

const ConfigSchema = z.object({
  repo: z.string().min(1),
  targetBranch: z.string().min(1).default("main"),
  issueQuery: z.string().min(1).default("state:open label:ready-for-agent"),
  branchPrefix: z.string().min(1).default("agent/issue-"),
  trainPrefix: z.string().min(1).default("train"),
  remote: z.string().min(1).default("origin"),
  models: z
    .object({
      implementation: z.string().min(1).default("gpt-5.6-terra"),
      repair: z.string().min(1).default("gpt-5.6-terra"),
      review: z.string().min(1).default("gpt-5.6-luna"),
    })
    .default({}),
  reasoning: z
    .object({
      implementation: ReasoningSchema.default("medium"),
      repair: ReasoningSchema.default("medium"),
      review: ReasoningSchema.default("low"),
    })
    .default({}),
  concurrency: z
    .object({
      implement: z.number().int().positive().max(32).default(3),
      validate: z.number().int().positive().max(32).default(4),
      github: z.number().int().positive().max(16).default(4),
    })
    .default({}),
  docker: z
    .object({
      imageName: z.string().min(1).default("sandcastle:agent-train"),
      codexHome: z.string().min(1).default(".sandcastle/codex-home"),
      cpus: z.number().positive().optional(),
      mounts: z
        .array(
          z.object({
            hostPath: z.string().min(1),
            sandboxPath: z.string().min(1),
            readonly: z.boolean().optional(),
          }),
        )
        .default([]),
    })
    .default({}),
  retention: z
    .object({
      ttlDays: z.number().int().positive().default(14),
      maxLogBytes: z.number().int().positive().default(10 * 1024 * 1024),
      keepSessions: z.boolean().default(true),
    })
    .default({}),
});

export const DEFAULT_CONFIG_PATH = ".sandcastle/agent-train.config.json";

export async function loadConfig(cwd: string, configPath = DEFAULT_CONFIG_PATH): Promise<AgentTrainConfig> {
  const resolvedPath = resolvePath(cwd, configPath);
  if (!(await pathExists(resolvedPath))) {
    throw new Error(`Missing agent train config at ${resolvedPath}`);
  }

  const parsed = ConfigSchema.parse(await readJson<unknown>(resolvedPath));
  if (parsed.repo === "OWNER/REPO") {
    throw new Error(`Configure "repo" in ${resolvedPath} before running agent-train.`);
  }

  return parsed;
}
