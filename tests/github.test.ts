import { describe, expect, test } from "bun:test";

import { GitHubClient, isPullRequestGreen } from "@/github.js";
import type { AgentTrainConfig } from "@/types.js";

import { FakeRunner } from "./helpers.js";

const config = {
  repo: "o/r",
  issueQuery: "state:open",
} as AgentTrainConfig;

describe("GitHubClient", () => {
  test("normalizes issue dependency fields from gh JSON", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      JSON.stringify([
        {
          number: 2,
          title: "Dependent",
          body: "body",
          state: "OPEN",
          url: "u",
          labels: [{ name: "ready-for-agent" }],
          blockedBy: [{ number: 1, title: "Base", state: "OPEN" }],
          blocking: [],
          parent: null,
          subIssues: { nodes: [{ number: 3, title: "Child" }] },
        },
      ])
    );

    const issues = await new GitHubClient(runner, "/repo").listIssues(config);
    expect(issues[0]?.blockedBy[0]?.number).toBe(1);
    expect(issues[0]?.subIssues[0]?.number).toBe(3);
    expect(runner.calls[0]?.options?.cwd).toBe("/repo");
  });

  test("posts PR review JSON through gh api", async () => {
    const runner = new FakeRunner();
    const client = new GitHubClient(runner, "/repo");

    await client.createPullRequestReview({
      repo: "o/r",
      pullNumber: 12,
      commitId: "abc",
      event: "REQUEST_CHANGES",
      body: "summary",
      comments: [{ path: "src/a.ts", position: 4, body: "finding" }],
    });

    expect(runner.calls[0]?.args).toEqual([
      "api",
      "--method",
      "POST",
      "/repos/o/r/pulls/12/reviews",
      "--input",
      "-",
    ]);
    expect(JSON.parse(runner.calls[0]?.options?.input ?? "{}")).toMatchObject({
      commit_id: "abc",
      event: "REQUEST_CHANGES",
      comments: [{ path: "src/a.ts", position: 4, body: "finding" }],
    });
  });

  test("blocks merge when required review is still pending", () => {
    expect(
      isPullRequestGreen({
        number: 12,
        url: "u",
        title: "t",
        state: "OPEN",
        headRefName: "h",
        baseRefName: "main",
        headRefOid: "sha",
        reviewDecision: "REVIEW_REQUIRED",
        statusCheckRollup: [],
      })
    ).toEqual({
      ok: false,
      reason: "PR #12 is still waiting for required review approval.",
    });
  });
});
