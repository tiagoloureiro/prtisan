import { describe, expect, test } from "bun:test";

import { scoreEvaluationCase } from "@/model-eval/scoring.js";
import { EvaluationCaseSchema } from "@/model-eval/types.js";

describe("model-evaluation scoring", () => {
  test("weights review F1 and attribution and disqualifies a critical miss", () => {
    const evaluationCase = reviewCase();
    const perfect = scoreEvaluationCase(evaluationCase, {
      kind: "review",
      structuredOutputValid: true,
      findings: [
        {
          severity: "blocking",
          title: "Missing authorization guard",
          body: "The handler allows an unauthorized mutation.",
          path: "src/handler.ts",
          rule: "Mutations require authorization.",
          evidence: "Line 42 calls save before checking the actor.",
        },
        {
          severity: "advisory",
          title: "Naming could be clearer",
          body: "Rename the helper.",
          path: "src/names.ts",
          rule: "Prefer domain names.",
          evidence: "The helper is named x.",
        },
      ],
    });
    expect(perfect.quality).toBe(100);
    expect(perfect.hardFailures).toEqual([]);

    const missed = scoreEvaluationCase(evaluationCase, {
      kind: "review",
      structuredOutputValid: true,
      findings: [],
    });
    expect(missed.quality).toBe(0);
    expect(missed.hardFailures).toContain("critical_blocker_miss");
  });

  test("scores malformed output zero without manufacturing findings", () => {
    const score = scoreEvaluationCase(reviewCase(), {
      kind: "review",
      structuredOutputValid: false,
      findings: [],
    });
    expect(score).toEqual({
      quality: 0,
      components: {},
      hardFailures: ["critical_blocker_miss"],
      malformed: true,
    });
  });

  test("disqualifies false approval of an unresolved critical finding", () => {
    const evaluationCase = EvaluationCaseSchema.parse({
      ...baseCase(),
      role: "repairVerification",
      gold: {
        kind: "repairVerification",
        originalFindingIds: ["critical", "resolved"],
        resolvedFindingIds: ["resolved"],
        criticalFindingIds: ["critical"],
        newBlockers: [],
      },
    });
    const score = scoreEvaluationCase(evaluationCase, {
      kind: "repairVerification",
      structuredOutputValid: true,
      resolvedFindingIds: ["critical", "resolved"],
      findings: [],
    });
    expect(score.hardFailures).toContain("false_critical_approval");
    expect(score.quality).toBeLessThan(100);
  });

  test("requires every mutation invariant for binary success", () => {
    const evaluationCase = EvaluationCaseSchema.parse({
      ...baseCase(),
      role: "ciRepair",
      execution: {
        ...baseCase().execution,
        mutationChecks: {
          intendedCauseCommand: "bun test intended",
          verificationCommands: ["bun test"],
          allowedPathPatterns: ["^src/"],
          gateIntegrityCommand: "bun test gate-integrity",
        },
      },
      gold: { kind: "mutation", intendedCause: "cancelled check handling" },
    });
    const failed = scoreEvaluationCase(evaluationCase, {
      kind: "mutation",
      structuredOutputValid: true,
      intendedCauseAddressed: true,
      verificationPassed: false,
      scopeRespected: false,
      gateIntegrityPreserved: false,
      unauthorizedMutation: true,
      verificationRegression: true,
    });
    expect(failed.quality).toBe(0);
    expect(failed.hardFailures).toEqual([
      "unauthorized_mutation",
      "gate_weakening",
      "verification_regression",
    ]);
  });
});

function reviewCase() {
  return EvaluationCaseSchema.parse({
    ...baseCase(),
    role: "standardsReview",
    gold: {
      kind: "review",
      findings: [
        {
          id: "authorization",
          severity: "blocking",
          critical: true,
          matcher: {
            path: "src/handler.ts",
            titlePattern: "authorization",
          },
          attribution: {
            evidenceRequired: true,
            ruleOrContractRequired: true,
          },
        },
        {
          id: "naming",
          severity: "advisory",
          matcher: { path: "src/names.ts", titlePattern: "naming" },
          attribution: {
            evidenceRequired: true,
            ruleOrContractRequired: true,
          },
        },
      ],
    },
  });
}

function baseCase() {
  return {
    id: "prtisan-case",
    repository: "prtisan",
    role: "standardsReview",
    split: "screening",
    source: { kind: "historical", commit: "abcdef1234567" },
    execution: {
      repositoryPath: "/private/repository",
      baseRef: "base-sha",
      headRef: "head-sha",
      config: {},
      task: {},
    },
    gold: { kind: "review", findings: [] },
  } as const;
}
