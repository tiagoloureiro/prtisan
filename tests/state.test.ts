import { describe, expect, test } from "bun:test";

import { buildIssueGraph, planBranches } from "@/graph.js";
import {
  createTrainState,
  mergeMetadataIntoPrBody,
  reconcileTrainState,
} from "@/state.js";
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

describe("PR metadata", () => {
  test("replaces prior metadata block idempotently", () => {
    const first = mergeMetadataIntoPrBody(
      "Body",
      '<!-- agent-train\n{"trainId":"a"}\nagent-train -->'
    );
    const second = mergeMetadataIntoPrBody(
      first,
      '<!-- agent-train\n{"trainId":"b"}\nagent-train -->'
    );

    expect(second).toContain('"trainId":"b"');
    expect(second).not.toContain('"trainId":"a"');
  });

  test("reconciles fresh issue data while preserving opened PR metadata", () => {
    const initialGraph = buildIssueGraph([
      issue({ number: 1, title: "Old title" }),
    ]);
    const initialPlan = planBranches(initialGraph, config, "train-a");
    const initialState = createTrainState(
      "train-a",
      config,
      initialGraph,
      initialPlan,
      new Date("2026-07-23T00:00:00Z")
    );
    const openedState = {
      ...initialState,
      issues: {
        "1": {
          ...initialState.issues["1"]!,
          status: "pr_opened" as const,
          branch: "agent/issue-1-old-title",
          pr: {
            number: 10,
            url: "https://github.com/o/r/pull/10",
            headRefName: "agent/issue-1-old-title",
            baseRefName: "main",
            headRefOid: "abc",
          },
        },
      },
    };

    const freshGraph = buildIssueGraph([
      issue({ number: 1, title: "New title" }),
    ]);
    const freshPlan = planBranches(freshGraph, config, "train-a");
    const reconciled = reconcileTrainState(
      openedState,
      config,
      freshGraph,
      freshPlan,
      new Date("2026-07-24T00:00:00Z")
    );

    expect(reconciled.issues["1"]?.issue.title).toBe("New title");
    expect(reconciled.issues["1"]?.branch).toBe("agent/issue-1-old-title");
    expect(reconciled.issues["1"]?.pr?.number).toBe(10);
  });
});
