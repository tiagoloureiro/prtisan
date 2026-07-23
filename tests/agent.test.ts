import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import { parseReviewReport, SandcastleCodexRunner } from "@/agent.js";

import { testConfig } from "./helpers.js";

let lastRunInput: {
  readonly sandbox?: { readonly env?: Record<string, string> };
  readonly agent?: {
    readonly options?: { readonly env?: Record<string, string> };
  };
};

mock.module("@ai-hero/sandcastle", () => ({
  Output: {
    object: (input: unknown) => input,
  },
  codex: (model: string, options: unknown) => ({
    provider: "codex",
    model,
    options,
  }),
  run: async (input: typeof lastRunInput) => {
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

    return {
      branch: "branch-1",
      commits: [],
      stdout: "",
      output: { summary: "", findings: [] },
      logFilePath: "/tmp/agent.log",
      iterations: [],
    };
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
      CODEX_HOME: "/home/agent/.codex-agent-train",
    });
    expect(lastRunInput.sandbox?.env).toBeUndefined();
  });
});
