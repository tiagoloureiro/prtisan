import { z } from "zod";

import type { CommandRunner } from "./exec.js";
import { AGENT_ROLES, type AgentRoleProfiles } from "./types.js";
import { stableDigest } from "./validation-hardening.js";

export const PRTISAN_MANIFEST_PATH = ".prtisan/manifest.json";
export const PRTISAN_DOCKERFILE_PATH = ".prtisan/Dockerfile";

const CommandSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1000),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
const ModelProfileSchema = z
  .object({
    model: z.string().min(1),
    reasoningEffort: ReasoningEffortSchema,
  })
  .strict();
const AgentRolesSchema = z
  .object(
    Object.fromEntries(
      AGENT_ROLES.map((role) => [role, ModelProfileSchema])
    ) as Record<(typeof AGENT_ROLES)[number], typeof ModelProfileSchema>
  )
  .strict();

const ManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
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
    codex: z.object({ roles: AgentRolesSchema }),
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
  })
  .strict();

const ManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    targetBranch: z.string().min(1).default("main"),
    sandbox: ManifestV2Schema.shape.sandbox,
    verification: ManifestV2Schema.shape.verification,
    contract: ManifestV2Schema.shape.contract,
    codex: z
      .object({
        reviewModel: z.string().min(1),
        repairModel: z.string().min(1),
        reviewEffort: ReasoningEffortSchema.default("medium"),
        repairEffort: ReasoningEffortSchema.default("medium"),
      })
      .strict(),
    limits: ManifestV2Schema.shape.limits,
  })
  .strict();

export type PrtisanManifest = z.infer<typeof ManifestV2Schema>;
export type PrtisanManifestV1 = z.infer<typeof ManifestV1Schema>;

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

export class ManifestMissingError extends ManifestError {
  constructor(
    readonly ref: string,
    message: string
  ) {
    super(message);
    this.name = "ManifestMissingError";
  }
}

export class ManifestUpgradeRequiredError extends ManifestError {
  constructor(
    readonly source: string,
    readonly legacy: PrtisanManifestV1
  ) {
    super(
      `${source} uses Prtisan manifest schema v1 and requires a reviewed schema-v2 setup upgrade.`
    );
    this.name = "ManifestUpgradeRequiredError";
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

  const legacy = ManifestV1Schema.safeParse(value);
  if (legacy.success) {
    throw new ManifestUpgradeRequiredError(source, legacy.data);
  }

  const parsed = ManifestV2Schema.safeParse(value);
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
    throw new ManifestMissingError(
      input.ref,
      `${PRTISAN_MANIFEST_PATH} is required on ${input.ref}.`
    );
  }
  return parseManifest(result.stdout, `${input.ref}:${PRTISAN_MANIFEST_PATH}`);
}

export function defaultManifest(input?: {
  readonly targetBranch?: string;
  readonly agentProfiles?: AgentRoleProfiles;
  readonly bootstrap?: z.infer<typeof CommandSchema>;
  readonly commands?: readonly z.infer<typeof CommandSchema>[];
}): PrtisanManifest {
  return ManifestV2Schema.parse({
    schemaVersion: 2,
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
      roles: input?.agentProfiles ?? defaultAgentProfiles(),
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

export function migrateManifestV1(
  legacy: PrtisanManifestV1,
  agentProfiles: AgentRoleProfiles = defaultAgentProfiles()
): PrtisanManifest {
  return ManifestV2Schema.parse({
    ...legacy,
    schemaVersion: 2,
    codex: { roles: agentProfiles },
  });
}

export function manifestForSetup(
  contents: string,
  source: string
): PrtisanManifest {
  try {
    return parseManifest(contents, source).manifest;
  } catch (error) {
    if (error instanceof ManifestUpgradeRequiredError) {
      return migrateManifestV1(error.legacy);
    }
    throw error;
  }
}

export function defaultAgentProfiles(): AgentRoleProfiles {
  return {
    standardsReview: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    specReview: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    repairVerification: {
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    },
    validationRepair: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    ciRepair: {
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    },
    mergeStateRepair: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    restackConflictRepair: {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
  };
}
