import { describe, expect, test } from "bun:test";

import { executeInit } from "@/commands/init.js";
import { readText } from "@/fs.js";
import { GitHubClient } from "@/github.js";

import { FakeRunner } from "./helpers.js";

describe("init command", () => {
  test("writes files locally when cwd is not a git repo", async () => {
    const cwd = `/tmp/agent-train-init-local-${crypto.randomUUID()}`;
    const runner = new FakeRunner();
    runner.enqueue("", 1, "not a git repository");

    const result = await executeInit(
      {
        cwd,
        repo: "o/r",
      },
      {
        runner,
        github: {} as GitHubClient,
      }
    );

    expect(result.mode).toBe("local");
    expect(result.reason).toContain("No git repository");
    expect(
      await readText(`${cwd}/.sandcastle/agent-train.config.json`)
    ).toContain('"repo": "o/r"');
  });

  test("creates issue and PR through GitHub for a GitHub git repo", async () => {
    const cwd = `/tmp/agent-train-init-github-${crypto.randomUUID()}`;
    const runner = new FakeRunner();
    runner.enqueue(`${cwd}\n`);
    runner.enqueue(
      JSON.stringify({
        nameWithOwner: "o/r",
        defaultBranchRef: { name: "main" },
      })
    );
    runner.enqueue("gh version 2.95.0 (2026-06-17)\n");
    runner.enqueue("");
    runner.enqueue("", 1);
    runner.enqueue("");
    runner.enqueue("");
    runner.enqueue(" M .gitignore\n?? .sandcastle/\n");
    runner.enqueue("");
    runner.enqueue("");
    runner.enqueue("");
    runner.enqueue("[]");
    runner.enqueue("https://github.com/o/r/issues/7\n");
    runner.enqueue("");
    runner.enqueue("[]");
    runner.enqueue("");
    runner.enqueue(
      JSON.stringify([
        {
          number: 8,
          url: "https://github.com/o/r/pull/8",
          title: "Configure Agent PR Train",
          state: "OPEN",
          isDraft: false,
          headRefName: "agent-train/setup",
          baseRefName: "main",
          headRefOid: "sha",
          statusCheckRollup: [],
        },
      ])
    );

    const result = await executeInit(
      {
        cwd,
      },
      {
        runner,
        github: new GitHubClient(runner, cwd),
      }
    );

    expect(result.mode).toBe("github");
    expect(result.issue?.number).toBe(7);
    expect(result.pr?.number).toBe(8);
    expect(
      runner.calls.some(
        (call) => call.command === "git" && call.args[0] === "push"
      )
    ).toBe(true);
    expect(
      runner.calls.some(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "issue" &&
          call.args[1] === "create"
      )
    ).toBe(true);
    expect(
      runner.calls.some(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "pr" &&
          call.args[1] === "create"
      )
    ).toBe(true);
  });
});
