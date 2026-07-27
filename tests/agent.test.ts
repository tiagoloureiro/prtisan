import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import { parseReviewReport, SandcastleCodexRunner } from "@/agent.js";
import { BunCommandRunner, mustRun } from "@/exec.js";

import { testConfig } from "./helpers.js";

interface SandcastleRunInput {
  readonly cwd?: string;
  readonly branchStrategy?: {
    readonly branch?: string;
  };
  readonly sandbox?: { readonly env?: Record<string, string> };
  readonly agent?: {
    readonly options?: { readonly env?: Record<string, string> };
  };
}

interface SandcastleRunResult {
  readonly branch: string;
  readonly commits: { readonly sha: string }[];
  readonly stdout: string;
  readonly output: unknown;
  readonly logFilePath: string;
  readonly iterations: [];
}

const defaultSandcastleRun = async (): Promise<SandcastleRunResult> => ({
  branch: "branch-1",
  commits: [],
  stdout: "",
  output: { summary: "", findings: [] },
  logFilePath: "/tmp/agent.log",
  iterations: [],
});

let lastRunInput: SandcastleRunInput;
let sandcastleRun: (input: SandcastleRunInput) => Promise<SandcastleRunResult> =
  defaultSandcastleRun;

mock.module("@ai-hero/sandcastle", () => ({
  Output: {
    object: (input: unknown) => input,
  },
  codex: (model: string, options: unknown) => ({
    provider: "codex",
    model,
    options,
  }),
  run: async (input: SandcastleRunInput) => {
    lastRunInput = input;
    const sandboxEnv = input.sandbox?.env ?? {};
    const agentEnv = input.agent?.options?.env ?? {};
    const overlapping = Object.keys(agentEnv).filter(
      (key) => key in sandboxEnv
    );
    if (overlapping.length > 0) {
      throw new Error(
        `Overlapping env keys between agent provider and sandbox provider: ${overlapping.join(", ")}`
      );
    }

    return sandcastleRun(input);
  },
}));

mock.module("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: (input: unknown) => input,
}));

describe("agent review parsing", () => {
  test("parses fenced JSON inside review tags", () => {
    const report = parseReviewReport(
      [
        "<review>",
        "```json",
        JSON.stringify({
          summary: "Needs work.",
          findings: [
            {
              severity: "blocking",
              title: "Missing check",
              body: "Add the guard.",
            },
          ],
        }),
        "```",
        "</review>",
        "<promise>COMPLETE</promise>",
      ].join("\n"),
      "spec"
    );

    expect(report.axis).toBe("spec");
    expect(report.findings[0]).toMatchObject({
      axis: "spec",
      severity: "blocking",
      title: "Missing check",
    });
  });
});

describe("SandcastleCodexRunner", () => {
  test("assigns CODEX_HOME only to the Codex agent provider env", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-train-test-"));
    const runner = new SandcastleCodexRunner();

    await runner.review({
      kind: "pull-request",
      cwd,
      config: testConfig(),
      runId: "test",
      axis: "standards",
      prNumber: 1,
      branch: "branch-1",
      baseBranch: "main",
      diff: "",
      relatedIssues: [],
    });

    expect(lastRunInput.agent?.options?.env).toEqual({
      CODEX_HOME: "/home/agent/.codex-prtisan",
    });
    expect(lastRunInput.sandbox?.env).toBeUndefined();
  });

  test("recovers commits created before a structured-output retry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-train-commit-test-"));
    const commandRunner = new BunCommandRunner();
    await mustRun(commandRunner, "git", ["init", "--initial-branch=main"], {
      cwd,
    });
    await mustRun(commandRunner, "git", ["config", "user.name", "Test User"], {
      cwd,
    });
    await mustRun(
      commandRunner,
      "git",
      ["config", "user.email", "test@example.com"],
      { cwd }
    );
    await writeFile(join(cwd, "file.txt"), "base\n");
    await mustRun(commandRunner, "git", ["add", "file.txt"], { cwd });
    await mustRun(commandRunner, "git", ["commit", "-m", "base"], { cwd });
    await mustRun(commandRunner, "git", ["branch", "repair-1"], { cwd });

    let repairCommit = "";
    sandcastleRun = async () => {
      await mustRun(commandRunner, "git", ["switch", "repair-1"], { cwd });
      await writeFile(join(cwd, "file.txt"), "repaired\n");
      await mustRun(commandRunner, "git", ["add", "file.txt"], { cwd });
      await mustRun(commandRunner, "git", ["commit", "-m", "repair"], {
        cwd,
      });
      repairCommit = (
        await mustRun(commandRunner, "git", ["rev-parse", "HEAD"], { cwd })
      ).stdout.trim();
      return {
        branch: "repair-1",
        commits: [],
        stdout: "",
        output: {
          addressedFindingIds: [],
          changedPaths: ["file.txt"],
          summary: "Repaired.",
          limitations: [],
        },
        logFilePath: "/tmp/agent.log",
        iterations: [],
      };
    };

    try {
      const outcome = await new SandcastleCodexRunner(commandRunner).repair({
        kind: "pull-request",
        cwd,
        config: testConfig(),
        runId: "test",
        relatedIssues: [],
        prNumber: 1,
        branch: "repair-1",
        baseBranch: "main",
        findings: [],
      });

      expect(outcome.commits).toEqual([repairCommit]);
    } finally {
      sandcastleRun = defaultSandcastleRun;
    }
  });
});
