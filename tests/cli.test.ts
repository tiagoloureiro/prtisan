import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "@/cli.js";

describe("CLI parsing", () => {
  test("rejects train ids", () => {
    expect(() => parseCliArgs(["validate", "--train-id", "abc"])).toThrow(
      "Unknown option: --train-id"
    );
  });

  test("accepts GitHub-native validate command without state selectors", () => {
    expect(parseCliArgs(["validate", "--repo", "o/r"])).toMatchObject({
      command: "validate",
      options: {
        repo: "o/r",
        repair: true,
      },
    });
  });
});
