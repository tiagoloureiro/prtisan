import { describe, expect, test } from "bun:test";

import {
  BASELINE_PROFILE,
  planNextEvaluation,
  qualifyAgainstBaseline,
  recommendProfiles,
  SCREENING_PROFILES,
  selectScreeningAdvancers,
} from "@/model-eval/tournament.js";
import type {
  EvaluationCase,
  EvaluationObservation,
  EvaluationProfile,
} from "@/model-eval/types.js";

const candidate: EvaluationProfile = {
  model: "gpt-5.6-terra",
  reasoningEffort: "medium",
};

describe("model-evaluation tournament", () => {
  test("advances Sol-medium plus at most three cheaper non-dominated profiles", () => {
    const observations = [
      observation("screen-sol", BASELINE_PROFILE, {
        split: "screening",
        quality: 100,
        credits: 10,
        duration: 100,
      }),
      observation("screen-terra", candidate, {
        split: "screening",
        quality: 99,
        credits: 5,
        duration: 90,
      }),
      observation(
        "screen-luna",
        { model: "gpt-5.6-luna", reasoningEffort: "medium" },
        {
          split: "screening",
          quality: 90,
          credits: 7,
          duration: 110,
        }
      ),
      observation(
        "screen-mini",
        { model: "gpt-5.4-mini", reasoningEffort: "low" },
        {
          split: "screening",
          quality: 80,
          credits: 2,
          duration: 80,
        }
      ),
    ];

    expect(selectScreeningAdvancers(observations, "standardsReview")).toEqual([
      BASELINE_PROFILE,
      { model: "gpt-5.4-mini", reasoningEffort: "low" },
      candidate,
    ]);
  });

  test("applies bootstrap quality and both latency gates", () => {
    const observations = holdoutPairs();
    const qualification = qualifyAgainstBaseline(
      observations,
      "standardsReview",
      candidate
    );

    expect(qualification.qualifies).toBe(true);
    expect(qualification.qualityInterval?.samples).toBe(10_000);
    expect(qualification.qualityInterval?.lower).toBeGreaterThanOrEqual(-2);

    const slow = observations.map((record) =>
      record.profile.model === candidate.model
        ? { ...record, agentDurationMs: 120 }
        : record
    );
    expect(
      qualifyAgainstBaseline(slow, "standardsReview", candidate).reasons
    ).toContain("paired median agent duration is slower than Sol");
  });

  test("falls back to Sol when evidence is incomplete or disqualified", () => {
    const incomplete = holdoutPairs().slice(0, 10);
    const recommendation = recommendProfiles(incomplete).find(
      (entry) => entry.role === "standardsReview"
    );
    expect(recommendation).toMatchObject({
      profile: BASELINE_PROFILE,
      retainedBaseline: true,
    });

    const disqualified = holdoutPairs().map((record, index) =>
      index === 1
        ? {
            ...record,
            score: {
              quality: 99,
              components: {},
              hardFailures: ["critical_blocker_miss" as const],
              malformed: false,
            },
          }
        : record
    );
    expect(
      qualifyAgainstBaseline(disqualified, "standardsReview", candidate)
        .qualifies
    ).toBe(false);
  });

  test("reserves a conservative P99 before scheduling another serial job", () => {
    const evaluationCase = {
      id: "case",
      repository: "prtisan",
      role: "standardsReview",
      split: "screening",
    } as const;
    expect(
      planNextEvaluation({
        cases: [evaluationCase] as never,
        observations: [],
        spentCredits: 0,
        creditCap: 1,
      })
    ).toMatchObject({
      kind: "budget_exhausted",
      remainingCredits: 1,
    });
  });

  test("uses at most the strongest cheaper medium profiles for high-effort rescue", () => {
    const cases = [
      minimalCase("screen", "screening"),
      ...Array.from({ length: 10 }, (_, index) =>
        minimalCase(`holdout-${index}`, "holdout")
      ),
    ];
    const screening = SCREENING_PROFILES.map((profile, index) =>
      observation("screen", profile, {
        split: "screening",
        quality:
          profile.model === "gpt-5.6-terra" &&
          profile.reasoningEffort === "medium"
            ? 99
            : 90 - index,
        credits:
          profile.model === BASELINE_PROFILE.model &&
          profile.reasoningEffort === BASELINE_PROFILE.reasoningEffort
            ? 10
            : 11,
        duration: 100,
      })
    );
    const baselineHoldouts = cases
      .filter((evaluationCase) => evaluationCase.split === "holdout")
      .flatMap((evaluationCase) =>
        [0, 1].map((replicate) =>
          observation(evaluationCase.id, BASELINE_PROFILE, {
            replicate,
            quality: 100,
            credits: 10,
            duration: 100,
          })
        )
      );

    expect(
      planNextEvaluation({
        cases,
        observations: [...screening, ...baselineHoldouts],
        spentCredits: 100,
      })
    ).toMatchObject({
      kind: "job",
      job: {
        caseId: "screen",
        profile: {
          model: "gpt-5.6-terra",
          reasoningEffort: "high",
        },
        stage: "high_effort_rescue",
      },
    });
  });
});

function holdoutPairs(): EvaluationObservation[] {
  return Array.from({ length: 10 }, (_, caseIndex) =>
    [0, 1].flatMap((replicate) => [
      observation(`case-${caseIndex}`, BASELINE_PROFILE, {
        replicate,
        quality: 100,
        credits: 10,
        duration: 100,
      }),
      observation(`case-${caseIndex}`, candidate, {
        replicate,
        quality: 99,
        credits: 5,
        duration: 90,
      }),
    ])
  ).flat();
}

function observation(
  caseId: string,
  profile: EvaluationProfile,
  input: {
    readonly split?: "screening" | "holdout";
    readonly replicate?: number;
    readonly quality: number;
    readonly credits: number;
    readonly duration: number;
  }
): EvaluationObservation {
  return {
    schemaVersion: 1,
    runId: "run",
    caseId,
    repository: "prtisan",
    role: "standardsReview",
    split: input.split ?? "holdout",
    profile,
    replicate: input.replicate ?? 0,
    terminalOutcome: "completed",
    excludedFromQuality: false,
    score: {
      quality: input.quality,
      components: {},
      hardFailures: [],
      malformed: false,
    },
    usage: {
      inputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 10,
    },
    credits: input.credits,
    agentDurationMs: input.duration,
    endToEndDurationMs: input.duration + 10,
    retryCount: 0,
    cacheUsed: false,
  };
}

function minimalCase(
  id: string,
  split: "screening" | "holdout"
): EvaluationCase {
  return {
    id,
    repository: "prtisan",
    role: "standardsReview",
    split,
  } as unknown as EvaluationCase;
}
