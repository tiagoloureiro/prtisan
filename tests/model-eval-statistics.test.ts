import { describe, expect, test } from "bun:test";

import { pairedBootstrap, percentile } from "@/model-eval/statistics.js";

describe("model-evaluation statistics", () => {
  test("uses a fixed-seed 10,000-sample paired bootstrap", () => {
    const pairs = Array.from({ length: 20 }, (_, index) => ({
      candidate: 98 + (index % 3),
      baseline: 100,
    }));
    const first = pairedBootstrap(pairs);
    const second = pairedBootstrap(pairs);

    expect(first).toEqual(second);
    expect(first.samples).toBe(10_000);
    expect(first.lower).toBeGreaterThanOrEqual(-2);
  });

  test("calculates interpolated median and p95 deterministically", () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8);
  });
});
