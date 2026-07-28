import { describe, expect, test } from "bun:test";

import {
  formatCleanupPreview,
  formatRunResult,
  main,
  parseCliArgs,
  runCodexLogin,
  runExitCode,
  runWithAuthentication,
} from "@/cli.js";
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

  test("parses the TUI and conservative cleanup interface", () => {
    expect(parseCliArgs(["tui", "--cwd", "/repo"])).toEqual({
      command: "tui",
      cwd: "/repo",
      help: false,
    });
    expect(
      parseCliArgs([
        "cleanup",
        "--all",
        "--only",
        "images",
        "--only",
        "caches",
        "--dry-run",
        "--json",
      ])
    ).toEqual({
      command: "cleanup",
      all: true,
      only: ["images", "caches"],
      dryRun: true,
      json: true,
      help: false,
    });
    expect(() => parseCliArgs(["cleanup", "--only", "docker"])).toThrow(
      "Unknown cleanup category"
    );
  });

  test("rejects removed mutating commands and missing plan ids", () => {
    expect(() => parseCliArgs(["merge"])).toThrow("Unknown command: merge");
    expect(() => parseCliArgs(["validate"])).toThrow(
      "Unknown command: validate"
    );
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
    expect(output.join("\n")).toContain("prtisan tui [--cwd <repo>]");
    expect(output.join("\n")).toContain("prtisan cleanup");
    expect(output.join("\n")).not.toContain("prtisan merge");
    expect(output.join("\n")).not.toContain("agent-train");
  });

  test("renders cleanup removals and conservative skips", () => {
    const output = formatCleanupPreview({
      authorizationId: "cleanup-preview",
      scope: { kind: "project", projectId: "project-1" },
      categories: ["images", "worktrees"],
      createdAt: "2026-07-28T00:00:00.000Z",
      candidates: [
        {
          id: "image:1",
          category: "images",
          projectId: "project-1",
          description: "Prtisan image one",
          target: "sha256:1",
          ownershipEvidence: "managed label",
          action: "remove",
        },
        {
          id: "worktree:/repo/worktree",
          category: "worktrees",
          projectId: "project-1",
          description: "Managed worktree",
          target: "/repo/worktree",
          ownershipEvidence: "registered path",
          action: "skip",
          reason: "worktree is dirty",
        },
      ],
    });

    expect(output).toContain("Will remove: 1");
    expect(output).toContain("Will preserve: 1");
    expect(output).toContain("worktree is dirty");
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
        message:
          "Merge setup PR #213 so the reviewed Prtisan configuration reaches main.",
        external: true,
      },
    };

    expect(formatRunResult(result)).toBe(
      [
        "Prtisan · o/r",
        "State: waiting_external",
        "Setup: #213 https://github.com/o/r/pull/213",
        "Blocker: Merge setup PR #213 so the reviewed Prtisan configuration reaches main.",
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

  test("renders live-run contention as a resumable checkpoint", () => {
    const result: WorkflowRunResult = {
      kind: "busy",
      cwd: "/repo",
      repo: "o/r",
      planId: "plan-123",
      outcome: "waiting_external",
      activeRun: {
        pid: 42,
        startedAt: "2026-07-27T00:00:00.000Z",
      },
      blocker: {
        category: "infrastructure",
        message:
          "Another Prtisan run is active for this repository (PID 42, started 2026-07-27T00:00:00.000Z).",
        external: true,
      },
    };

    expect(formatRunResult(result)).toBe(
      [
        "Prtisan · o/r",
        "Plan: plan-123",
        "State: waiting_external",
        "Active run: PID 42 (started 2026-07-27T00:00:00.000Z)",
        "Blocker: Another Prtisan run is active for this repository (PID 42, started 2026-07-27T00:00:00.000Z).",
        "Resume: prtisan run --cwd /repo",
      ].join("\n")
    );
    expect(runExitCode(result)).toBe(2);
  });

  test("authenticates once in an interactive run and resumes in the same invocation", async () => {
    const results: WorkflowRunResult[] = [
      {
        kind: "authentication",
        cwd: "/repo",
        repo: "o/r",
        outcome: "waiting_external",
        authentication: {
          kind: "codex_login",
          codexHome: "/state/prtisan/codex-home",
          command:
            "CODEX_HOME=/state/prtisan/codex-home codex login --device-auth",
        },
        blocker: {
          category: "credentials",
          message: "Codex authentication is required for Prtisan.",
          external: true,
          remediation: {
            kind: "codex_login",
            codexHome: "/state/prtisan/codex-home",
            command:
              "CODEX_HOME=/state/prtisan/codex-home codex login --device-auth",
          },
        },
      },
      {
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
      },
    ];
    const loginHomes: string[] = [];
    let runCalls = 0;

    const result = await runWithAuthentication(
      async () => results[runCalls++] as WorkflowRunResult,
      {
        interactive: true,
        json: false,
        login: async (codexHome) => {
          loginHomes.push(codexHome);
          return 0;
        },
      }
    );

    expect(result.kind).toBe("train");
    expect(runCalls).toBe(2);
    expect(loginHomes).toEqual(["/state/prtisan/codex-home"]);
  });

  test("uses device authentication against the dedicated Codex home", async () => {
    let invocation:
      | {
          readonly command: readonly string[];
          readonly options: {
            readonly env: Record<string, string | undefined>;
            readonly stdin: string;
            readonly stdout: string;
            readonly stderr: string;
          };
        }
      | undefined;

    const exitCode = await runCodexLogin(
      "/state/prtisan/codex-home",
      (command, options) => {
        invocation = { command, options };
        return { exited: Promise.resolve(0) };
      }
    );

    expect(exitCode).toBe(0);
    expect(invocation).toMatchObject({
      command: ["codex", "login", "--device-auth"],
      options: {
        env: { CODEX_HOME: "/state/prtisan/codex-home" },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    });
  });

  test("does not start interactive login for JSON output", async () => {
    const checkpoint: WorkflowRunResult = {
      kind: "authentication",
      cwd: "/repo",
      repo: "o/r",
      outcome: "waiting_external",
      authentication: {
        kind: "codex_login",
        codexHome: "/state/prtisan/codex-home",
        command:
          "CODEX_HOME=/state/prtisan/codex-home codex login --device-auth",
      },
      blocker: {
        category: "credentials",
        message: "Codex authentication is required for Prtisan.",
        external: true,
      },
    };
    let loginCalls = 0;

    const result = await runWithAuthentication(async () => checkpoint, {
      interactive: true,
      json: true,
      login: async () => {
        loginCalls += 1;
        return 0;
      },
    });

    expect(result).toBe(checkpoint);
    expect(loginCalls).toBe(0);
    expect(runExitCode(result)).toBe(2);
  });

  test("retries a journaled train when authentication expires during an agent run", async () => {
    const remediation = {
      kind: "codex_login" as const,
      codexHome: "/state/prtisan/codex-home",
      command: "CODEX_HOME=/state/prtisan/codex-home codex login --device-auth",
    };
    const blocked: WorkflowRunResult = {
      kind: "train",
      cwd: "/repo",
      repo: "o/r",
      planId: "plan-123",
      snapshot: {
        planId: "plan-123",
        repositoryKey: "repo-key",
        outcome: "waiting_external",
        updatedAt: "2026-07-27T00:00:00.000Z",
        merged: [],
        attempts: [],
        blocker: {
          category: "credentials",
          message: "Codex authentication is required for Prtisan.",
          remediation,
          external: true,
        },
        nextAction: "Resume the existing plan.",
      },
    };
    const completed: WorkflowRunResult = {
      ...blocked,
      snapshot: {
        ...blocked.snapshot,
        outcome: "completed",
        merged: [117],
        blocker: undefined,
      },
    };
    let calls = 0;

    const result = await runWithAuthentication(
      async () => (calls++ === 0 ? blocked : completed),
      {
        interactive: true,
        json: false,
        login: async () => 0,
      }
    );

    expect(result).toBe(completed);
    expect(calls).toBe(2);
  });
});
