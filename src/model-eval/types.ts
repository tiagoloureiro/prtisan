import { z } from "zod";

import { AGENT_ROLES } from "@/types.js";

export const EVALUATION_REPOSITORIES = [
  "prtisan",
  "titally",
  "titance",
  "titect",
  "titrain",
] as const;

export const EvaluationProfileSchema = z.object({
  model: z.string().min(1),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
});

const GoldFindingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(["blocking", "advisory"]),
    critical: z.boolean().default(false),
    matcher: z
      .object({
        path: z.string().optional(),
        titlePattern: z.string().optional(),
        bodyPattern: z.string().optional(),
        rulePattern: z.string().optional(),
        evidencePattern: z.string().optional(),
      })
      .refine((matcher) => Object.values(matcher).some(Boolean), {
        message: "A gold finding needs at least one deterministic matcher.",
      }),
    attribution: z.object({
      evidenceRequired: z.boolean().default(true),
      ruleOrContractRequired: z.boolean().default(true),
    }),
  })
  .refine((finding) => !finding.critical || finding.severity === "blocking", {
    message: "Only blocking findings may be marked critical.",
  });

const ReviewGoldSchema = z.object({
  kind: z.literal("review"),
  findings: z.array(GoldFindingSchema),
});

const RepairVerificationGoldSchema = z
  .object({
    kind: z.literal("repairVerification"),
    originalFindingIds: z.array(z.string().min(1)).min(1),
    resolvedFindingIds: z.array(z.string().min(1)),
    criticalFindingIds: z.array(z.string().min(1)).default([]),
    newBlockers: z.array(GoldFindingSchema).default([]),
  })
  .superRefine((gold, context) => {
    const originals = new Set(gold.originalFindingIds);
    for (const id of [...gold.resolvedFindingIds, ...gold.criticalFindingIds]) {
      if (!originals.has(id)) {
        context.addIssue({
          code: "custom",
          message: `${id} is not an original finding id.`,
        });
      }
    }
    if (gold.newBlockers.some((finding) => finding.severity !== "blocking")) {
      context.addIssue({
        code: "custom",
        message: "Repair-verification new blockers must be blocking.",
      });
    }
  });

const MutationGoldSchema = z.object({
  kind: z.literal("mutation"),
  intendedCause: z.string().min(1),
});

export const EvaluationGoldSchema = z.discriminatedUnion("kind", [
  ReviewGoldSchema,
  RepairVerificationGoldSchema,
  MutationGoldSchema,
]);

const EvaluationExecutionSchema = z.object({
  repositoryPath: z.string().min(1),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  task: z.record(z.string(), z.unknown()),
  mutationChecks: z
    .object({
      intendedCauseCommand: z.string().min(1),
      verificationCommands: z.array(z.string().min(1)).min(1),
      allowedPathPatterns: z.array(z.string().min(1)).min(1),
      gateIntegrityCommand: z.string().min(1),
    })
    .optional(),
});

export const EvaluationCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  repository: z.enum(EVALUATION_REPOSITORIES),
  role: z.enum(AGENT_ROLES),
  split: z.enum(["screening", "holdout"]),
  source: z.object({
    kind: z.enum(["historical", "seeded"]),
    commit: z.string().min(7),
    patchDigest: z.string().min(16).optional(),
  }),
  execution: EvaluationExecutionSchema,
  gold: EvaluationGoldSchema,
});

export const ModelEvaluationCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  frozenAt: z.string().datetime(),
  goldFrozenAt: z.string().datetime(),
  authoredBy: z.string().min(1),
  pins: z.object({
    promptDigest: z.string().min(16),
    toolDigest: z.string().min(16),
    dockerImage: z.string().min(1),
    codeReviewSkillDigest: z.string().min(16),
    runtimeDigest: z.string().min(16),
    verificationDigest: z.string().min(16),
  }),
  cases: z.array(EvaluationCaseSchema),
});

export type EvaluationProfile = z.infer<typeof EvaluationProfileSchema>;
export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;
export type EvaluationGold = z.infer<typeof EvaluationGoldSchema>;
export type ModelEvaluationCorpus = z.infer<typeof ModelEvaluationCorpusSchema>;

export interface CandidateFinding {
  readonly severity: "blocking" | "advisory";
  readonly title: string;
  readonly body: string;
  readonly path?: string;
  readonly rule?: string;
  readonly evidence?: string;
}

export type CandidateCaseResult =
  | {
      readonly kind: "review";
      readonly structuredOutputValid: boolean;
      readonly findings: readonly CandidateFinding[];
    }
  | {
      readonly kind: "repairVerification";
      readonly structuredOutputValid: boolean;
      readonly resolvedFindingIds: readonly string[];
      readonly findings: readonly CandidateFinding[];
    }
  | {
      readonly kind: "mutation";
      readonly structuredOutputValid: boolean;
      readonly intendedCauseAddressed: boolean;
      readonly verificationPassed: boolean;
      readonly scopeRespected: boolean;
      readonly gateIntegrityPreserved: boolean;
      readonly unauthorizedMutation: boolean;
      readonly verificationRegression: boolean;
    };

export type EvaluationHardFailure =
  | "critical_blocker_miss"
  | "false_critical_approval"
  | "unauthorized_mutation"
  | "gate_weakening"
  | "verification_regression";

export interface CaseScore {
  readonly quality: number;
  readonly components: Readonly<Record<string, number>>;
  readonly hardFailures: readonly EvaluationHardFailure[];
  readonly malformed: boolean;
}

export interface EvaluationObservation {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly caseId: string;
  readonly repository: (typeof EVALUATION_REPOSITORIES)[number];
  readonly role: (typeof AGENT_ROLES)[number];
  readonly split: "screening" | "holdout";
  readonly profile: EvaluationProfile;
  readonly replicate: number;
  readonly terminalOutcome:
    "completed" | "infrastructure_failed" | "execution_failed";
  readonly excludedFromQuality: boolean;
  readonly score?: CaseScore;
  readonly usage?: {
    readonly inputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheReadInputTokens: number;
    readonly outputTokens: number;
  };
  readonly credits?: number;
  readonly agentDurationMs?: number;
  readonly endToEndDurationMs: number;
  readonly retryCount: number;
  readonly cacheUsed?: boolean;
}

export interface ProfileRecommendation {
  readonly role: (typeof AGENT_ROLES)[number];
  readonly profile: EvaluationProfile;
  readonly retainedBaseline: boolean;
  readonly rationale: string;
  readonly sampleCount: number;
  readonly medianCredits?: number;
  readonly medianAgentDurationMs?: number;
}
