import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import {
  AgentOutputError,
  parseReviewReport,
  SandcastleCodexRunner,
} from "@/agent.js";
import { BunCommandRunner, mustRun } from "@/exec.js";
import type { AgentRoleProfiles } from "@/types.js";

import { testConfig } from "./helpers.js";

interface SandcastleRunInput {
  readonly cwd?: string;
  readonly branchStrategy?: {
    readonly branch?: string;
  };
  readonly sandbox?: { readonly env?: Record<string, string> };
  readonly agent?: {
    readonly model?: string;
    readonly options?: {
      readonly effort?: string;
      readonly env?: Record<string, string>;
    };
  };
}

interface SandcastleIteration {
  readonly usage?: {
    readonly inputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheReadInputTokens: number;
    readonly outputTokens: number;
  };
}

interface SandcastleRunResult {
  readonly branch: string;
  readonly commits: { readonly sha: string }[];
  readonly stdout: string;
  readonly output: unknown;
  readonly logFilePath: string;
  readonly iterations: readonly SandcastleIteration[];
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

  test("passes the exact role profile and aggregates every retry usage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-train-profile-test-"));
    const defaults = testConfig();
    const config = testConfig({
      agentProfiles: {
        ...defaults.agentProfiles,
        standardsReview: {
          model: "gpt-5.6-terra",
          reasoningEffort: "high",
        },
      },
    });
    sandcastleRun = async () => ({
      branch: "branch-1",
      commits: [],
      stdout: "",
      output: { summary: "", findings: [] },
      logFilePath: "/tmp/agent.log",
      iterations: [
        {
          usage: {
            inputTokens: 100,
            cacheCreationInputTokens: 20,
            cacheReadInputTokens: 30,
            outputTokens: 40,
          },
        },
        {
          usage: {
            inputTokens: 10,
            cacheCreationInputTokens: 2,
            cacheReadInputTokens: 3,
            outputTokens: 4,
          },
        },
      ],
    });

    try {
      const report = await new SandcastleCodexRunner().review({
        kind: "pull-request",
        cwd,
        config,
        runId: "test",
        axis: "standards",
        prNumber: 1,
        branch: "branch-1",
        baseBranch: "main",
        diff: "",
        relatedIssues: [],
      });

      expect(lastRunInput.agent).toMatchObject({
        model: "gpt-5.6-terra",
        options: { effort: "high" },
      });
      expect(report.invocation).toMatchObject({
        role: "standardsReview",
        profile: {
          model: "gpt-5.6-terra",
          reasoningEffort: "high",
        },
        iterations: 2,
        retryCount: 1,
        cacheUsed: true,
        usage: {
          inputTokens: 110,
          cacheCreationInputTokens: 22,
          cacheReadInputTokens: 33,
          outputTokens: 44,
        },
      });
      expect(report.invocation?.creditCost?.credits).toBeCloseTo(0.02495625, 8);
    } finally {
      sandcastleRun = defaultSandcastleRun;
    }
  });

  test("maps every supported agent task exhaustively to its frozen role", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-train-roles-test-"));
    const roles = [
      "standardsReview",
      "specReview",
      "repairVerification",
      "validationRepair",
      "ciRepair",
      "mergeStateRepair",
      "restackConflictRepair",
    ] as const;
    const config = testConfig({
      agentProfiles: Object.fromEntries(
        roles.map((role) => [
          role,
          { model: `model-${role}`, reasoningEffort: "low" },
        ])
      ) as AgentRoleProfiles,
    });
    const runner = new SandcastleCodexRunner();
    const observed: string[] = [];
    const capture = async (operation: () => Promise<unknown>) => {
      await operation();
      observed.push(lastRunInput.agent?.model ?? "");
    };
    const base = {
      cwd,
      config,
      runId: "test",
      prNumber: 1,
      branch: "branch-1",
      baseBranch: "main",
    };

    await capture(() =>
      runner.review({
        ...base,
        kind: "pull-request",
        axis: "standards",
        diff: "",
        relatedIssues: [],
      })
    );
    await capture(() =>
      runner.review({
        ...base,
        kind: "pull-request",
        axis: "spec",
        diff: "",
        relatedIssues: [],
      })
    );
    await capture(() =>
      runner.verifyRepair({
        ...base,
        baseRefOid: "base-sha",
        repairedHeadRefOid: "head-sha",
        relatedIssues: [],
        findings: [],
      })
    );
    await capture(() =>
      runner.repair({
        ...base,
        kind: "pull-request",
        relatedIssues: [],
        findings: [],
      })
    );
    await capture(() =>
      runner.repair({
        ...base,
        kind: "ci-failure",
        relatedIssues: [],
        checkEvidence: [],
      })
    );
    await capture(() =>
      runner.repair({
        ...base,
        kind: "merge-state",
        relatedIssues: [],
        mergeState: "DIRTY",
        blockers: ["conflict"],
      })
    );
    await capture(() =>
      runner.repair({
        ...base,
        kind: "restack-conflict",
        parentContract: "parent",
        childContract: "child",
        uniqueDiff: "",
      })
    );

    expect(observed).toEqual(roles.map((role) => `model-${role}`));
  });

  test("retains retry usage when structured output is malformed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-train-malformed-test-"));
    sandcastleRun = async () => {
      throw Object.assign(new Error("invalid structured output JSON"), {
        iterations: [
          {
            usage: {
              inputTokens: 100,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 20,
              outputTokens: 30,
            },
          },
          {
            usage: {
              inputTokens: 10,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 2,
              outputTokens: 3,
            },
          },
        ],
      });
    };

    try {
      const error = await new SandcastleCodexRunner()
        .review({
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
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AgentOutputError);
      expect((error as AgentOutputError).invocation).toMatchObject({
        iterations: 2,
        retryCount: 1,
        usage: {
          inputTokens: 110,
          cacheReadInputTokens: 22,
          outputTokens: 33,
        },
      });
    } finally {
      sandcastleRun = defaultSandcastleRun;
    }
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
