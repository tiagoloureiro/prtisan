import { describe, expect, test } from "bun:test";

import { GitClient } from "@/git.js";
import { prtisanRepositoryDataPath } from "@/prtisan-paths.js";

import { FakeRunner, testConfig } from "./helpers.js";

describe("GitClient", () => {
  test("publishes a verified commit with the exact expected remote SHA", async () => {
    const runner = new FakeRunner();
    const client = new GitClient(runner, "/repo", testConfig());

    await client.pushVerifiedCommit({
      branch: "feature",
      commit: "verified-sha",
      expectedRemoteSha: "expected-head",
    });

    expect(runner.calls[0]?.args).toEqual([
      "push",
      "origin",
      "--force-with-lease=refs/heads/feature:expected-head",
      "verified-sha:refs/heads/feature",
    ]);
  });

  test("publishes ordinary repairs only as fast-forward additions", async () => {
    const runner = new FakeRunner();
    runner.enqueue("");
    runner.enqueue("expected-head\trefs/heads/feature\n");
    runner.enqueue("");
    const client = new GitClient(runner, "/repo", testConfig());

    await client.pushAdditiveCommit({
      branch: "feature",
      commit: "repair-sha",
      expectedRemoteSha: "expected-head",
    });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["merge-base", "--is-ancestor", "expected-head", "repair-sha"],
      ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/feature"],
      ["push", "origin", "repair-sha:refs/heads/feature"],
    ]);
  });

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
        `worktree ${prtisanRepositoryDataPath("/repo", "runs", "fixture", "worktrees", "feature")}`,
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
      options: {
        cwd: prtisanRepositoryDataPath(
          "/repo",
          "runs",
          "fixture",
          "worktrees",
          "feature"
        ),
      },
    });
    expect(runner.calls).toContainEqual({
      command: "git",
      args: ["clean", "-fd"],
      options: {
        cwd: prtisanRepositoryDataPath(
          "/repo",
          "runs",
          "fixture",
          "worktrees",
          "feature"
        ),
      },
    });
  });

  test("digests only root and changed-path repository standards at the pinned ref", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      [
        "AGENTS.md",
        "CONTRIBUTING.md",
        "packages/a/AGENTS.md",
        "packages/b/AGENTS.md",
      ].join("\n")
    );
    runner.enqueue("root rules");
    runner.enqueue("contribution rules");
    runner.enqueue("package a rules");
    const client = new GitClient(runner, "/repo", testConfig());

    const standards = await client.readStandardsAtRef("head-sha", [
      "packages/a/src/index.ts",
    ]);

    expect(standards).toEqual([
      "AGENTS.md\nroot rules",
      "CONTRIBUTING.md\ncontribution rules",
      "packages/a/AGENTS.md\npackage a rules",
    ]);
    expect(
      runner.calls.some((call) =>
        call.args.includes("head-sha:packages/b/AGENTS.md")
      )
    ).toBe(false);
  });
});
