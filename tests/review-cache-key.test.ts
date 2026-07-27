import { describe, expect, test } from "bun:test";

import { reviewCacheKey } from "@/review-cache.js";

describe("review cache identity", () => {
  test("includes the exact agent role and model profile", () => {
    const base = {
      snapshotKey: "snapshot",
      axis: "standards" as const,
      role: "standardsReview" as const,
      profile: {
        model: "gpt-5.6-sol",
        reasoningEffort: "medium" as const,
      },
      promptSchemaDigest: "prompt",
    };
    const baseline = reviewCacheKey(base);

    expect(
      reviewCacheKey({
        ...base,
        role: "specReview",
        axis: "spec",
      })
    ).not.toBe(baseline);
    expect(
      reviewCacheKey({
        ...base,
        profile: { ...base.profile, model: "gpt-5.6-terra" },
      })
    ).not.toBe(baseline);
    expect(
      reviewCacheKey({
        ...base,
        profile: { ...base.profile, reasoningEffort: "low" },
      })
    ).not.toBe(baseline);
  });
});
