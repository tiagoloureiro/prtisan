import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  assertPrivacyMinimal,
  buildRedactedReport,
  repriceObservations,
} from "@/model-eval/report.js";
import { ModelEvaluationStore } from "@/model-eval/store.js";
import type { EvaluationObservation } from "@/model-eval/types.js";

describe("model-evaluation reporting", () => {
  test("reprices stored token measurements without changing validation identity", () => {
    const observation = fixtureObservation();
    const repriced = repriceObservations([{ ...observation, credits: 999 }]);
    expect(repriced[0]?.credits).not.toBe(999);
    expect(repriced[0]?.caseId).toBe(observation.caseId);
    expect(repriced[0]?.score).toEqual(observation.score);
  });

  test("rejects private fields and emits only redacted aggregates", () => {
    expect(() =>
      assertPrivacyMinimal({ nested: { prompt: "private" } })
    ).toThrow("forbidden");
    const report = buildRedactedReport({
      runId: "run",
      corpusDigest: "a".repeat(64),
      observations: [fixtureObservation()],
      generatedAt: "2026-07-27T00:00:00.000Z",
      minimumPairs: 1,
    });
    expect(() => assertPrivacyMinimal(report)).not.toThrow();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("/private/repository");
    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain('"patch"');
  });

  test("reports missing usage and pricing as unavailable rather than zero", () => {
    const report = buildRedactedReport({
      runId: "run",
      corpusDigest: "a".repeat(64),
      observations: [
        { ...fixtureObservation(), usage: undefined, credits: undefined },
      ],
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(report.totals.credits).toEqual({
      total: null,
      unavailableSamples: 1,
    });
    expect(report.totals.tokenMix.unavailableSamples).toBe(1);
  });

  test("resumes idempotently from a 0600 SQLite store", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-eval-store-"));
    const path = join(root, "private", "runs.sqlite");
    const store = await ModelEvaluationStore.open(path);
    try {
      const run = store.createOrResume(
        "a".repeat(64),
        5_000,
        new Date("2026-07-27T00:00:00.000Z")
      );
      expect(store.createOrResume("a".repeat(64)).id).toBe(run.id);
      const observation = { ...fixtureObservation(), runId: run.id };
      expect(store.saveObservation(observation)).toBe(true);
      expect(store.saveObservation(observation)).toBe(false);
      expect(store.observations(run.id)).toHaveLength(1);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });
});

function fixtureObservation(): EvaluationObservation {
  return {
    schemaVersion: 1,
    runId: "run",
    caseId: "case",
    repository: "prtisan",
    role: "standardsReview",
    split: "holdout",
    profile: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    replicate: 0,
    terminalOutcome: "completed",
    excludedFromQuality: false,
    score: {
      quality: 100,
      components: { blockingFindingF1: 1 },
      hardFailures: [],
      malformed: false,
    },
    usage: {
      inputTokens: 100,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
      outputTokens: 40,
    },
    credits: 1,
    agentDurationMs: 100,
    endToEndDurationMs: 120,
    retryCount: 0,
    cacheUsed: true,
  };
}
