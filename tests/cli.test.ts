import { describe, expect, test } from "bun:test";

import { main, parseCliArgs } from "@/cli.js";

describe("Prtisan CLI", () => {
  test("parses the plan/apply/status/export interface", () => {
    expect(parseCliArgs(["plan", "--cwd", "/repo"])).toEqual({
      command: "plan",
      cwd: "/repo",
      help: false,
    });
    expect(parseCliArgs(["apply", "plan-123"])).toMatchObject({
      command: "apply",
      id: "plan-123",
    });
    expect(parseCliArgs(["status", "plan-123"])).toMatchObject({
      command: "status",
      id: "plan-123",
    });
    expect(parseCliArgs(["export", "plan-123"])).toMatchObject({
      command: "export",
      id: "plan-123",
    });
  });

  test("parses two-phase repository onboarding", () => {
    expect(parseCliArgs(["init", "plan", "--cwd", "/repo"])).toMatchObject({
      command: "init",
      action: "plan",
      cwd: "/repo",
    });
    expect(parseCliArgs(["init", "apply", "setup-123"])).toMatchObject({
      command: "init",
      action: "apply",
      id: "setup-123",
    });
  });

  test("rejects removed mutating commands and missing plan ids", () => {
    expect(() => parseCliArgs(["merge"])).toThrow("Unknown command: merge");
    expect(() => parseCliArgs(["validate"])).toThrow(
      "Unknown command: validate"
    );
    expect(() => parseCliArgs(["tui"])).toThrow("Unknown command: tui");
    expect(() => parseCliArgs(["apply"])).toThrow("apply requires a value");
    expect(() => parseCliArgs(["init", "apply"])).toThrow(
      "init apply requires a value"
    );
  });

  test("publishes only the new interface in help", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      output.push(values.map(String).join(" "));
    };
    try {
      expect(await main(["--help"])).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(output.join("\n")).toContain("prtisan apply <plan-id>");
    expect(output.join("\n")).not.toContain("prtisan merge");
    expect(output.join("\n")).not.toContain("agent-train");
  });
});
