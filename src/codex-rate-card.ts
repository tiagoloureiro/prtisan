import type { CreditCost, TokenUsage } from "./types.js";

export interface CodexModelRates {
  readonly inputCreditsPerMillion: number;
  readonly cachedInputCreditsPerMillion: number;
  readonly outputCreditsPerMillion: number;
}

export interface CodexRateCard {
  readonly id: string;
  readonly source: string;
  readonly accessedAt: string;
  readonly rates: Readonly<Record<string, CodexModelRates>>;
}

export const CODEX_RATE_CARD: CodexRateCard = {
  id: "openai-codex-token-rates-2026-07-27",
  source: "https://help.openai.com/en/articles/20001106-codex-rate-card.docx",
  accessedAt: "2026-07-27",
  rates: {
    "gpt-5.6-sol": {
      inputCreditsPerMillion: 125,
      cachedInputCreditsPerMillion: 12.5,
      outputCreditsPerMillion: 750,
    },
    "gpt-5.6-terra": {
      inputCreditsPerMillion: 62.5,
      cachedInputCreditsPerMillion: 6.25,
      outputCreditsPerMillion: 375,
    },
    "gpt-5.6-luna": {
      inputCreditsPerMillion: 25,
      cachedInputCreditsPerMillion: 2.5,
      outputCreditsPerMillion: 150,
    },
    "gpt-5.4-mini": {
      inputCreditsPerMillion: 18.75,
      cachedInputCreditsPerMillion: 1.875,
      outputCreditsPerMillion: 113,
    },
  },
};

export function calculateCreditCost(
  model: string,
  usage: TokenUsage,
  rateCard: CodexRateCard = CODEX_RATE_CARD
): CreditCost | undefined {
  const rates = rateCard.rates[model];
  if (!rates) return undefined;

  const credits =
    ((usage.inputTokens + usage.cacheCreationInputTokens) *
      rates.inputCreditsPerMillion +
      usage.cacheReadInputTokens * rates.cachedInputCreditsPerMillion +
      usage.outputTokens * rates.outputCreditsPerMillion) /
    1_000_000;
  return {
    rateCardId: rateCard.id,
    credits,
  };
}

export function aggregateTokenUsage(
  usages: readonly (TokenUsage | undefined)[]
): TokenUsage | undefined {
  if (usages.length === 0 || usages.some((usage) => usage === undefined)) {
    return undefined;
  }
  return (usages as readonly TokenUsage[]).reduce<TokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      cacheCreationInputTokens:
        total.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      cacheReadInputTokens:
        total.cacheReadInputTokens + usage.cacheReadInputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
    }),
    {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
    }
  );
}
