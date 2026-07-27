import { describe, expect, test } from "bun:test";

import { formatRunResult, main, parseCliArgs, runExitCode } from "@/cli.js";
import type { WorkflowRunResult } from "@/workflow/workflow.js";

describe("Prtisan CLI", () => {
  test("parses the one-command train interface", () => {
    expect(parseCliArgs(["run", "--cwd", "/repo"])).toEqual({
      command: "run",
      cwd: "/repo",
      help: false,
    });
    expect(parseCliArgs(["run", "--cwd", "/repo", "--json"])).toEqual({
      command: "run",
      cwd: "/repo",
      json: true,
      help: false,
    });
  });

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
    expect(output.join("\n")).toContain("prtisan run [--cwd <repo>] [--json]");
    expect(output.join("\n")).toContain("prtisan apply <plan-id>");
    expect(output.join("\n")).not.toContain("prtisan merge");
    expect(output.join("\n")).not.toContain("agent-train");
  });

  test("renders a concise setup checkpoint with the exact resume command", () => {
    const result: WorkflowRunResult = {
      kind: "setup",
      cwd: "/repo",
      repo: "o/r",
      targetBranch: "main",
      outcome: "waiting_external",
      setupPr: {
        number: 213,
        url: "https://github.com/o/r/pull/213",
      },
      blocker: {
        category: "policy",
        message: "Merge setup PR #213 so .prtisan/manifest.json reaches main.",
        external: true,
      },
    };

    expect(formatRunResult(result)).toBe(
      [
        "Prtisan · o/r",
        "State: waiting_external",
        "Setup: #213 https://github.com/o/r/pull/213",
        "Blocker: Merge setup PR #213 so .prtisan/manifest.json reaches main.",
        "Resume: prtisan run --cwd /repo",
      ].join("\n")
    );
    expect(JSON.parse(formatRunResult(result, true))).toMatchObject({
      kind: "setup",
      outcome: "waiting_external",
      resumeCommand: "prtisan run --cwd /repo",
    });
    expect(runExitCode(result)).toBe(2);
  });

  test("renders train progress and maps terminal outcomes to exit codes", () => {
    const result: WorkflowRunResult = {
      kind: "train",
      cwd: "/repo",
      repo: "o/r",
      planId: "plan-123",
      snapshot: {
        planId: "plan-123",
        repositoryKey: "repo-key",
        outcome: "completed",
        updatedAt: "2026-07-27T00:00:00.000Z",
        merged: [117],
        attempts: [],
        nextAction: "The planned open PR train is complete.",
      },
    };

    expect(formatRunResult(result)).toBe(
      [
        "Prtisan · o/r",
        "Plan: plan-123",
        "State: completed",
        "Merged: #117",
        "Next: The planned open PR train is complete.",
      ].join("\n")
    );
    expect(runExitCode(result)).toBe(0);
    expect(
      runExitCode({
        ...result,
        snapshot: {
          ...result.snapshot,
          outcome: "infrastructure_failed",
        },
      })
    ).toBe(1);
  });
});
