import { describe, expect, test } from "bun:test";

import type { AgentRunner } from "@/agent.js";
import type { MergeInput, MergeResult } from "@/commands/merge.js";
import type { ValidateInput, ValidateResult } from "@/commands/validate.js";
import type { GitClient } from "@/git.js";
import type { GitHubClient } from "@/github.js";
import {
  createAgentTrainRuntime,
  TuiPreflightError,
  type TuiProgressEvent,
} from "@/tui/runtime.js";

import { FakeRunner, testConfig } from "./helpers.js";

describe("TUI runtime", () => {
  test("blocks validate when runtime readiness fails", async () => {
    const events: TuiProgressEvent[] = [];
    let validateCalled = false;
    const runtime = createAgentTrainRuntime(
      { cwd: "/repo" },
      {
        runner: new FakeRunner(),
        github: {} as GitHubClient,
        git: {} as GitClient,
        agent: {} as AgentRunner,
        loadConfig: async () => testConfig(),
        checkReadiness: async () => [
          {
            name: "Docker",
            status: "failed",
            details: "Docker is unavailable",
          },
        ],
        validateCommand: async () => {
          validateCalled = true;
          return emptyValidateResult();
        },
      }
    );
    runtime.subscribe((event) => events.push(event));

    await expect(runtime.validate()).rejects.toThrow(TuiPreflightError);

    expect(validateCalled).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "preflight" })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "action",
        action: "validate",
        status: "failed",
      })
    );
  });

  test("passes TUI validate options to the validate workflow", async () => {
    let received: ValidateInput | undefined;
    const runtime = createAgentTrainRuntime(
      { cwd: "/repo", repair: false },
      {
        runner: new FakeRunner(),
        github: {} as GitHubClient,
        git: {} as GitClient,
        agent: {} as AgentRunner,
        loadConfig: async () => testConfig({ repo: "o/r" }),
        checkReadiness: async () => [{ name: "Bun runtime", status: "ok" }],
        pruneArtifacts: async () => {},
        validateCommand: async (input) => {
          received = input;
          return emptyValidateResult();
        },
      }
    );

    await runtime.validate();

    expect(received).toMatchObject({
      cwd: "/repo",
      repair: false,
      config: { repo: "o/r" },
    });
  });

  test("blocks merge when runtime readiness fails", async () => {
    let mergeCalled = false;
    const runtime = createAgentTrainRuntime(
      { cwd: "/repo" },
      {
        runner: new FakeRunner(),
        github: {} as GitHubClient,
        git: {} as GitClient,
        agent: {} as AgentRunner,
        loadConfig: async () => testConfig(),
        checkReadiness: async () => [
          {
            name: "GitHub CLI",
            status: "failed",
          },
        ],
        mergeCommand: async () => {
          mergeCalled = true;
          return emptyMergeResult();
        },
      }
    );

    await expect(runtime.merge()).rejects.toThrow(TuiPreflightError);

    expect(mergeCalled).toBe(false);
  });

  test("passes TUI merge options to the merge workflow", async () => {
    let received: MergeInput | undefined;
    const runtime = createAgentTrainRuntime(
      { cwd: "/repo", validateAffected: false },
      {
        runner: new FakeRunner(),
        github: {} as GitHubClient,
        git: {} as GitClient,
        agent: {} as AgentRunner,
        loadConfig: async () => testConfig({ repo: "o/r" }),
        checkReadiness: async () => [{ name: "Bun runtime", status: "ok" }],
        pruneArtifacts: async () => {},
        mergeCommand: async (input) => {
          received = input;
          return emptyMergeResult();
        },
      }
    );

    await runtime.merge();

    expect(received).toMatchObject({
      cwd: "/repo",
      validateAffected: false,
      config: { repo: "o/r" },
    });
  });
});

function emptyValidateResult(): ValidateResult {
  return {
    repo: "o/r",
    checkedAt: "2026-07-23T00:00:00.000Z",
    pullRequests: [],
    issues: [],
  };
}

function emptyMergeResult(): MergeResult {
  return {
    repo: "o/r",
    merged: [],
  };
}
