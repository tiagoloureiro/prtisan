import { describe, expect, test } from "bun:test";

import {
  aggregateTokenUsage,
  calculateCreditCost,
  CODEX_RATE_CARD,
} from "@/codex-rate-card.js";

const usage = {
  inputTokens: 1_000_000,
  cacheCreationInputTokens: 100_000,
  cacheReadInputTokens: 500_000,
  outputTokens: 200_000,
};

describe("Codex rate card", () => {
  test("pins the official versioned rates and applies the documented formula", () => {
    expect(CODEX_RATE_CARD.rates["gpt-5.6-sol"]).toEqual({
      inputCreditsPerMillion: 125,
      cachedInputCreditsPerMillion: 12.5,
      outputCreditsPerMillion: 750,
    });
    expect(calculateCreditCost("gpt-5.6-sol", usage)).toEqual({
      rateCardId: CODEX_RATE_CARD.id,
      credits: 293.75,
    });
  });

  test("records an unpriced model as unavailable", () => {
    expect(calculateCreditCost("unpriced-model", usage)).toBeUndefined();
  });

  test("aggregates all attempts without converting missing usage to zero", () => {
    expect(
      aggregateTokenUsage([
        usage,
        {
          inputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
          outputTokens: 5,
        },
      ])
    ).toEqual({
      inputTokens: 1_000_002,
      cacheCreationInputTokens: 100_003,
      cacheReadInputTokens: 500_004,
      outputTokens: 200_005,
    });
    expect(aggregateTokenUsage([])).toBeUndefined();
    expect(aggregateTokenUsage([usage, undefined])).toBeUndefined();
  });
});
