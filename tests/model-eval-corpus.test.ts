import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  assertCorpusPinsCurrent,
  currentCorpusPins,
  PrivateEvaluationArtifactStore,
  validateCorpusShape,
} from "@/model-eval/corpus.js";
import {
  EVALUATION_REPOSITORIES,
  ModelEvaluationCorpusSchema,
} from "@/model-eval/types.js";
import { AGENT_ROLES } from "@/types.js";

describe("model-evaluation corpus", () => {
  test("requires one screening and two hidden holdouts per role/repository", () => {
    const corpus = frozenCorpus();
    expect(() => validateCorpusShape(corpus)).not.toThrow();
    expect(corpus.cases).toHaveLength(105);

    expect(() =>
      validateCorpusShape({ ...corpus, cases: corpus.cases.slice(1) })
    ).toThrow("exactly one screening and two holdout");
  });

  test("stores private raw outputs and patches with 0600 permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-eval-private-"));
    await chmod(root, 0o755);
    const store = new PrivateEvaluationArtifactStore(root);
    const path = await store.write("run", "case", "profile", {
      output: "private",
      patch: "private",
    });

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "run"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "run", "case"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("invalidates frozen cases when prompts, tools, skills, or runtime pins change", async () => {
    const corpus = frozenCorpus();
    const currentPins = await currentCorpusPins(corpus);
    const current = { ...corpus, pins: currentPins };
    await expect(assertCorpusPinsCurrent(current)).resolves.toBeUndefined();
    await expect(
      assertCorpusPinsCurrent({
        ...current,
        pins: { ...currentPins, promptDigest: "0".repeat(64) },
      })
    ).rejects.toThrow("promptDigest");
  });

  test("rejects non-deterministic or invalid case oracles", () => {
    const corpus = frozenCorpus();
    const mutationIndex = corpus.cases.findIndex(
      (evaluationCase) => evaluationCase.gold.kind === "mutation"
    );
    const mutation = corpus.cases[mutationIndex];
    if (!mutation?.execution.mutationChecks) {
      throw new Error("Expected a mutation fixture.");
    }
    const cases = [...corpus.cases];
    cases[mutationIndex] = {
      ...mutation,
      execution: {
        ...mutation.execution,
        mutationChecks: {
          ...mutation.execution.mutationChecks,
          allowedPathPatterns: ["["],
        },
      },
    };

    expect(() => validateCorpusShape({ ...corpus, cases })).toThrow(
      "invalid deterministic matcher"
    );
  });
});

function frozenCorpus() {
  return ModelEvaluationCorpusSchema.parse({
    schemaVersion: 1,
    frozenAt: "2026-07-27T00:00:00.000Z",
    goldFrozenAt: "2026-07-27T00:00:00.000Z",
    authoredBy: "maintainer",
    pins: {
      promptDigest: "a".repeat(64),
      toolDigest: "b".repeat(64),
      dockerImage: "sha256:fixture",
      codeReviewSkillDigest: "c".repeat(64),
      runtimeDigest: "d".repeat(64),
      verificationDigest: "e".repeat(64),
    },
    cases: AGENT_ROLES.flatMap((role) =>
      EVALUATION_REPOSITORIES.flatMap((repository) =>
        ["screening", "holdout", "holdout"].map((split, index) => ({
          id: `${role.toLowerCase()}-${repository}-${index}`,
          repository,
          role,
          split,
          source: {
            kind: index === 0 ? "historical" : "seeded",
            commit: "abcdef1234567890",
            patchDigest: "f".repeat(64),
          },
          execution: {
            repositoryPath: `/private/${repository}`,
            baseRef: "base-sha",
            headRef: "head-sha",
            config: {},
            task: {},
            ...(role.endsWith("Repair")
              ? {
                  mutationChecks: {
                    intendedCauseCommand: "true",
                    verificationCommands: ["true"],
                    allowedPathPatterns: [".*"],
                    gateIntegrityCommand: "true",
                  },
                }
              : {}),
          },
          gold:
            role === "standardsReview" || role === "specReview"
              ? { kind: "review", findings: [] }
              : role === "repairVerification"
                ? {
                    kind: "repairVerification",
                    originalFindingIds: ["finding"],
                    resolvedFindingIds: [],
                    criticalFindingIds: [],
                    newBlockers: [],
                  }
                : { kind: "mutation", intendedCause: "fixture" },
        }))
      )
    ),
  });
}
