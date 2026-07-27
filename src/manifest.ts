import { z } from "zod";

import type { CommandRunner } from "./exec.js";
import { stableDigest } from "./validation-hardening.js";

export const PRTISAN_MANIFEST_PATH = ".prtisan/manifest.json";
export const PRTISAN_DOCKERFILE_PATH = ".prtisan/Dockerfile";

const CommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 1000),
  env: z.record(z.string(), z.string()).optional(),
});

const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  targetBranch: z.string().min(1).default("main"),
  sandbox: z.object({
    provider: z.literal("docker").default("docker"),
    dockerfile: z.string().min(1).default(PRTISAN_DOCKERFILE_PATH),
    context: z.string().min(1).default("."),
    imageName: z.string().min(1).default("prtisan:repository"),
    cpus: z.number().positive().max(64).default(2),
  }),
  verification: z.object({
    bootstrap: CommandSchema.optional(),
    commands: z.array(CommandSchema).min(1),
  }),
  contract: z
    .object({
      prBodySections: z
        .array(z.string().min(1))
        .default(["Summary", "Acceptance criteria"]),
    })
    .default({ prBodySections: ["Summary", "Acceptance criteria"] }),
  codex: z.object({
    reviewModel: z.string().min(1),
    repairModel: z.string().min(1),
    reviewEffort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
    repairEffort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  }),
  limits: z
    .object({
      readConcurrency: z.number().int().positive().max(16).default(2),
      githubConcurrency: z.number().int().positive().max(16).default(4),
      maxRepairCandidates: z.literal(3).default(3),
      maxCandidatesPerCause: z.literal(2).default(2),
      applyLeaseTtlMs: z
        .number()
        .int()
        .positive()
        .max(24 * 60 * 60 * 1000)
        .default(2 * 60 * 60 * 1000),
    })
    .default({
      readConcurrency: 2,
      githubConcurrency: 4,
      maxRepairCandidates: 3,
      maxCandidatesPerCause: 2,
      applyLeaseTtlMs: 2 * 60 * 60 * 1000,
    }),
});

export type PrtisanManifest = z.infer<typeof ManifestSchema>;

export interface LoadedManifest {
  readonly manifest: PrtisanManifest;
  readonly contents: string;
  readonly digest: string;
  readonly ref: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export function parseManifest(
  contents: string,
  source: string
): LoadedManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new ManifestError(
      `${source} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ManifestError(
      `${source} is invalid: ${parsed.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`
        )
        .join("; ")}`
    );
  }

  return {
    manifest: parsed.data,
    contents,
    digest: stableDigest(contents),
    ref: source,
  };
}

export async function loadManifestAtRef(input: {
  readonly runner: CommandRunner;
  readonly cwd: string;
  readonly ref: string;
}): Promise<LoadedManifest> {
  const result = await input.runner.run(
    "git",
    ["show", `${input.ref}:${PRTISAN_MANIFEST_PATH}`],
    { cwd: input.cwd }
  );
  if (result.exitCode !== 0) {
    throw new ManifestError(
      `${PRTISAN_MANIFEST_PATH} is required on ${input.ref}. Run \`prtisan init plan\` and merge its setup PR first.`
    );
  }
  return parseManifest(result.stdout, `${input.ref}:${PRTISAN_MANIFEST_PATH}`);
}

export function defaultManifest(input?: {
  readonly targetBranch?: string;
  readonly reviewModel?: string;
  readonly repairModel?: string;
  readonly bootstrap?: z.infer<typeof CommandSchema>;
  readonly commands?: readonly z.infer<typeof CommandSchema>[];
}): PrtisanManifest {
  return ManifestSchema.parse({
    schemaVersion: 1,
    targetBranch: input?.targetBranch ?? "main",
    sandbox: {
      provider: "docker",
      dockerfile: PRTISAN_DOCKERFILE_PATH,
      context: ".",
      imageName: "prtisan:repository",
      cpus: 2,
    },
    verification: {
      bootstrap: input?.bootstrap,
      commands: input?.commands ?? [
        {
          name: "Project verification",
          command: "REPLACE_WITH_REPOSITORY_VERIFICATION_COMMAND",
          timeoutMs: 30 * 60 * 1000,
        },
      ],
    },
    contract: {
      prBodySections: ["Summary", "Acceptance criteria"],
    },
    codex: {
      reviewModel: input?.reviewModel ?? "gpt-5.6-sol",
      repairModel: input?.repairModel ?? "gpt-5.6-sol",
      reviewEffort: "medium",
      repairEffort: "medium",
    },
    limits: {
      readConcurrency: 2,
      githubConcurrency: 4,
      maxRepairCandidates: 3,
      maxCandidatesPerCause: 2,
      applyLeaseTtlMs: 2 * 60 * 60 * 1000,
    },
  });
}
