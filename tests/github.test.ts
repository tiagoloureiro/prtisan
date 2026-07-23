import { describe, expect, test } from "bun:test";

import { GitHubClient, isPullRequestGreen } from "@/github.js";

import { FakeRunner, pullRequest } from "./helpers.js";

describe("GitHubClient", () => {
  test("normalizes issue dependency fields from gh JSON", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      JSON.stringify({
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
      })
    );

    const issue = await new GitHubClient(runner, "/repo").getIssue("o/r", 2);
    expect(issue.blockedBy[0]?.number).toBe(1);
    expect(issue.subIssues[0]?.number).toBe(3);
    expect(runner.calls[0]?.options?.cwd).toBe("/repo");
  });

  test("lists all open PRs including drafts", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      JSON.stringify([
        {
          number: 7,
          title: "Stacked",
          body: "",
          state: "OPEN",
          isDraft: true,
          url: "https://github.com/o/r/pull/7",
          headRefName: "feature",
          baseRefName: "main",
          baseRefOid: "base",
          headRefOid: "head",
          closingIssuesReferences: [{ number: 70, title: "Spec" }],
          latestReviews: [],
          statusCheckRollup: [],
        },
      ])
    );

    const prs = await new GitHubClient(runner, "/repo").listOpenPullRequests(
      "o/r"
    );

    expect(runner.calls[0]?.args).toEqual([
      "pr",
      "list",
      "--repo",
      "o/r",
      "--state",
      "open",
      "--json",
      expect.stringContaining("closingIssuesReferences"),
      "--limit",
      "1000",
    ]);
    expect(prs[0]).toMatchObject({
      number: 7,
      isDraft: true,
      closingIssuesReferences: [{ number: 70, title: "Spec" }],
    });
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
      isPullRequestGreen(
        pullRequest({
          number: 12,
          url: "u",
          title: "t",
          headRefName: "h",
          baseRefName: "main",
          headRefOid: "sha",
          reviewDecision: "REVIEW_REQUIRED",
          statusCheckRollup: [],
        })
      )
    ).toEqual({
      ok: false,
      reason: "PR #12 is still waiting for required review approval.",
    });
  });
});
