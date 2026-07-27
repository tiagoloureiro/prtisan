import { describe, expect, test } from "bun:test";

import { parseEvalArgs } from "@/model-eval/cli.js";

describe("maintainer model-evaluation CLI", () => {
  test("supports validate-corpus, resumable run, and report operations", () => {
    expect(
      parseEvalArgs(["validate-corpus", "--corpus", "/private/corpus.json"])
    ).toMatchObject({
      command: "validate-corpus",
      corpus: "/private/corpus.json",
      cap: 5_000,
    });
    expect(parseEvalArgs(["run", "--cap", "2500"])).toMatchObject({
      command: "run",
      cap: 2_500,
    });
    expect(
      parseEvalArgs(["report", "--output", "evals/report.json"])
    ).toMatchObject({
      command: "report",
      output: "evals/report.json",
    });
  });

  test("keeps report-only options out of benchmark execution", () => {
    expect(() => parseEvalArgs(["run", "--output", "report.json"])).toThrow(
      "--output is only supported by report"
    );
  });
});
