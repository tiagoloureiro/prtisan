import { describe, expect, test } from "bun:test";

import { main, parseCliArgs } from "@/cli.js";

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

  test("accepts the TUI command with shared repo options", () => {
    expect(
      parseCliArgs([
        "tui",
        "--cwd",
        "/repo",
        "--repo",
        "o/r",
        "--config",
        "agent-train.json",
        "--target-branch",
        "trunk",
      ])
    ).toMatchObject({
      command: "tui",
      options: {
        cwd: "/repo",
        repo: "o/r",
        config: "agent-train.json",
        targetBranch: "trunk",
      },
    });
  });

  test("includes the TUI command in help", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      output.push(values.map(String).join(" "));
    };
    try {
      expect(await main(["tui", "--help"])).toBe(0);
    } finally {
      console.log = originalLog;
    }

    expect(output.join("\n")).toContain("agent-train tui");
  });
});
