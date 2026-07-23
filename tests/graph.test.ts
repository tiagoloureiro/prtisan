import { describe, expect, test } from "bun:test";

import { buildIssueGraph, descendantsOf, planBranches } from "@/graph.js";
import type { AgentTrainConfig } from "@/types.js";

import { issue } from "./helpers.js";

const config: AgentTrainConfig = {
  repo: "o/r",
  targetBranch: "main",
  issueQuery: "state:open",
  branchPrefix: "agent/issue-",
  trainPrefix: "train",
  remote: "origin",
  models: {
    implementation: "gpt-5.6-terra",
    repair: "gpt-5.6-terra",
    review: "gpt-5.6-luna",
  },
  reasoning: {
    implementation: "medium",
    repair: "medium",
    review: "low",
  },
  concurrency: {
    implement: 3,
    validate: 4,
    github: 4,
  },
  docker: {
    imageName: "sandcastle:agent-train",
    codexHome: ".sandcastle/codex-home",
    mounts: [],
  },
  retention: {
    ttlDays: 14,
    maxLogBytes: 1000,
    keepSessions: true,
  },
};

describe("issue graph", () => {
  test("layers issues by native blockers", () => {
    const graph = buildIssueGraph([
      issue({ number: 1, title: "A", blocking: [{ number: 3 }] }),
      issue({ number: 2, title: "B", blocking: [{ number: 3 }] }),
      issue({
        number: 3,
        title: "C",
        blockedBy: [{ number: 1 }, { number: 2 }],
        blocking: [{ number: 4 }],
      }),
      issue({ number: 4, title: "D", blockedBy: [{ number: 3 }] }),
    ]);

    expect(graph.layers).toEqual([[1, 2], [3], [4]]);
    expect(descendantsOf(graph, 1)).toEqual([3, 4]);
  });

  test("derives descendants from reverse blockedBy edges", () => {
    const graph = buildIssueGraph([
      issue({ number: 1, title: "A" }),
      issue({ number: 2, title: "B", blockedBy: [{ number: 1 }] }),
      issue({ number: 3, title: "C", blockedBy: [{ number: 2 }] }),
    ]);

    expect(descendantsOf(graph, 1)).toEqual([2, 3]);
  });

  test("ignores closed blockers and records external blockers", () => {
    const graph = buildIssueGraph([
      issue({ number: 1, title: "closed", state: "CLOSED" }),
      issue({
        number: 2,
        title: "active",
        blockedBy: [
          { number: 1, state: "CLOSED" },
          { number: 99, state: "OPEN" },
        ],
      }),
    ]);

    expect(graph.layers).toEqual([[2]]);
    expect(graph.nodes.get(2)?.closedBlockers).toEqual([1]);
    expect(graph.nodes.get(2)?.externalOpenBlockers).toEqual([99]);
  });

  test("detects dependency cycles", () => {
    expect(() =>
      buildIssueGraph([
        issue({ number: 1, title: "A", blockedBy: [{ number: 2 }] }),
        issue({ number: 2, title: "B", blockedBy: [{ number: 1 }] }),
      ])
    ).toThrow(/cycle/i);
  });

  test("plans synthetic base branch for multi-blocker issue", () => {
    const graph = buildIssueGraph([
      issue({ number: 1, title: "API" }),
      issue({ number: 2, title: "UI" }),
      issue({
        number: 3,
        title: "Wire it",
        blockedBy: [{ number: 1 }, { number: 2 }],
      }),
    ]);
    const plan = planBranches(graph, config, "20260723-test");

    expect(plan.issues.get(1)?.baseBranch).toBe("main");
    expect(plan.issues.get(3)).toMatchObject({
      baseBranch: "train/20260723-test/base/3",
      syntheticBase: "train/20260723-test/base/3",
    });
  });
});
