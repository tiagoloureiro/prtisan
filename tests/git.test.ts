import { describe, expect, test } from "bun:test";

import { GitClient } from "@/git.js";

import { FakeRunner, testConfig } from "./helpers.js";

describe("GitClient", () => {
  test("prepares a branch that is checked out in a managed worktree", async () => {
    const runner = new FakeRunner();
    runner.enqueue("");
    runner.enqueue("");
    runner.enqueue("");
    runner.enqueue("");
    runner.enqueue(
      [
        "worktree /repo",
        "HEAD main-sha",
        "branch refs/heads/main",
        "",
        "worktree /repo/.sandcastle/worktrees/feature",
        "HEAD old-feature-sha",
        "branch refs/heads/feature",
        "",
      ].join("\n")
    );
    runner.enqueue("/repo\n");

    const client = new GitClient(
      runner,
      "/repo",
      testConfig({ remote: "origin", targetBranch: "main" })
    );

    await client.prepareBranchFromBase("feature", "main");

    expect(
      runner.calls.some(
        (call) =>
          call.command === "git" &&
          call.args[0] === "branch" &&
          call.args[1] === "-f" &&
          call.args[2] === "feature"
      )
    ).toBe(false);
    expect(runner.calls).toContainEqual({
      command: "git",
      args: ["reset", "--hard", "origin/feature"],
      options: { cwd: "/repo/.sandcastle/worktrees/feature" },
    });
    expect(runner.calls).toContainEqual({
      command: "git",
      args: ["clean", "-fd"],
      options: { cwd: "/repo/.sandcastle/worktrees/feature" },
    });
  });
});
