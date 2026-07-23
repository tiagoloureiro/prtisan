import { describe, expect, test } from "bun:test";

import type { CommandOptions, CommandResult } from "@/exec.js";
import {
  GitHubClient,
  isPullRequestGreen,
  pullRequestCheckStatus,
} from "@/github.js";

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
          reviews: [
            {
              state: "COMMENTED",
              body: "review body",
              author: { login: "agent" },
            },
          ],
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
      reviews: [{ state: "COMMENTED", authorLogin: "agent" }],
    });
  });

  test("lists all open issues with dependency context", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      JSON.stringify([
        {
          number: 11,
          title: "Spec",
          body: "Build it",
          state: "OPEN",
          url: "https://github.com/o/r/issues/11",
          labels: [],
          blockedBy: [{ number: 10, title: "Base" }],
          blocking: [],
          parent: null,
          subIssues: [],
        },
      ])
    );

    const issues = await new GitHubClient(runner, "/repo").listOpenIssues(
      "o/r"
    );

    expect(runner.calls[0]?.args).toEqual([
      "issue",
      "list",
      "--repo",
      "o/r",
      "--state",
      "open",
      "--json",
      expect.stringContaining("blockedBy"),
      "--limit",
      "1000",
    ]);
    expect(issues[0]).toMatchObject({
      number: 11,
      title: "Spec",
      blockedBy: [{ number: 10 }],
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

  test("downgrades unprocessable change requests to review comments", async () => {
    const runner = new FakeRunner();
    runner.enqueue("", 1, "gh: Unprocessable Entity (HTTP 422)");
    runner.enqueue("");
    const client = new GitHubClient(runner, "/repo");

    await client.createPullRequestReview({
      repo: "o/r",
      pullNumber: 12,
      commitId: "abc",
      event: "REQUEST_CHANGES",
      body: "summary",
      comments: [{ path: "src/a.ts", position: 4, body: "finding" }],
    });

    expect(runner.calls).toHaveLength(2);
    expect(JSON.parse(runner.calls[1]?.options?.input ?? "{}")).toMatchObject({
      event: "COMMENT",
      comments: [{ path: "src/a.ts", position: 4, body: "finding" }],
    });
  });

  test("preserves rejected inline comments in a body-only review", async () => {
    const runner = new FakeRunner();
    runner.enqueue("", 1, "gh: Unprocessable Entity (HTTP 422)");
    runner.enqueue("");
    const client = new GitHubClient(runner, "/repo");

    await client.createPullRequestReview({
      repo: "o/r",
      pullNumber: 12,
      commitId: "abc",
      event: "COMMENT",
      body: "summary",
      comments: [{ path: "src/a.ts", position: 4, body: "finding" }],
    });

    expect(runner.calls).toHaveLength(2);
    expect(JSON.parse(runner.calls[1]?.options?.input ?? "{}")).toMatchObject({
      event: "COMMENT",
      comments: [],
      body: expect.stringContaining("finding"),
    });
  });

  test("posts issue comments through gh api", async () => {
    const runner = new FakeRunner();
    const client = new GitHubClient(runner, "/repo");

    await client.createIssueComment("o/r", 33, "validation summary");

    expect(runner.calls[0]?.args).toEqual([
      "api",
      "--method",
      "POST",
      "/repos/o/r/issues/33/comments",
      "--input",
      "-",
    ]);
    expect(JSON.parse(runner.calls[0]?.options?.input ?? "{}")).toEqual({
      body: "validation summary",
    });
  });

  test("classifies failed and pending status checks", () => {
    const checks = pullRequestCheckStatus(
      pullRequest({
        statusCheckRollup: [
          {
            name: "unit",
            status: "COMPLETED",
            conclusion: "FAILURE",
          },
          {
            name: "e2e",
            status: "IN_PROGRESS",
          },
          {
            name: "lint",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
      })
    );

    expect(checks.failed.map((check) => check.name)).toEqual(["unit"]);
    expect(checks.pending.map((check) => check.name)).toEqual(["e2e"]);
    expect(checks.successful.map((check) => check.name)).toEqual(["lint"]);
  });

  test("fetches GitHub Actions failed-check logs and keeps external checks as summary evidence", async () => {
    const runner = new FakeRunner();
    runner.enqueue("failing test log");
    const client = new GitHubClient(runner, "/repo");

    const evidence = await client.getPullRequestCheckEvidence(
      "o/r",
      pullRequest({
        statusCheckRollup: [
          {
            name: "actions",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://github.com/o/r/actions/runs/123/job/456",
          },
          {
            context: "external-ci",
            state: "FAILURE",
            targetUrl: "https://ci.example.test/build/1",
          },
        ],
      })
    );

    expect(runner.calls[0]?.args).toEqual([
      "run",
      "view",
      "123",
      "--repo",
      "o/r",
      "--log-failed",
    ]);
    expect(evidence).toContainEqual(
      expect.objectContaining({
        name: "actions",
        runId: "123",
        logExcerpt: "failing test log",
      })
    );
    const external = evidence.find((check) => check.name === "external-ci");
    expect(external).toMatchObject({
      detailsUrl: "https://ci.example.test/build/1",
    });
    expect(external?.logExcerpt).toBeUndefined();
  });

  test("creates a new PR when a matching branch only has closed PRs", async () => {
    const runner = new ClosedBranchPrRunner();
    const client = new GitHubClient(runner, "/repo");

    const pr = await client.createOrUpdatePullRequest({
      repo: "o/r",
      title: "Configure Agent PR Train",
      body: "body",
      baseBranch: "main",
      headBranch: "agent-train/setup",
    });

    expect(pr.number).toBe(211);
    expect(
      runner.calls.some(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "pr" &&
          call.args[1] === "edit"
      )
    ).toBe(false);
    expect(
      runner.calls.some(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "pr" &&
          call.args[1] === "create"
      )
    ).toBe(true);
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

class ClosedBranchPrRunner extends FakeRunner {
  private created = false;

  override async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    if (isSetupPrList(command, args)) {
      this.calls.push({ command, args, options });
      const state = args[args.indexOf("--state") + 1];
      const prs =
        state === "open"
          ? this.created
            ? [
                pullRequest({
                  number: 211,
                  headRefName: "agent-train/setup",
                  headRefOid: "new-sha",
                }),
              ]
            : []
          : [
              pullRequest({
                number: 210,
                state: "CLOSED",
                headRefName: "agent-train/setup",
                headRefOid: "old-sha",
              }),
            ];

      return result(command, args, options, JSON.stringify(prs));
    }

    if (command === "gh" && args[0] === "pr" && args[1] === "edit") {
      this.calls.push({ command, args, options });
      return result(
        command,
        args,
        options,
        "",
        1,
        "GraphQL: Cannot change the base branch of a closed pull request. (updatePullRequest)"
      );
    }

    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      this.calls.push({ command, args, options });
      this.created = true;
      return result(command, args, options, "");
    }

    return super.run(command, args, options);
  }
}

function isSetupPrList(command: string, args: readonly string[]): boolean {
  return (
    command === "gh" &&
    args[0] === "pr" &&
    args[1] === "list" &&
    args.includes("--head") &&
    args[args.indexOf("--head") + 1] === "agent-train/setup"
  );
}

function result(
  command: string,
  args: readonly string[],
  options: CommandOptions | undefined,
  stdout: string,
  exitCode = 0,
  stderr = ""
): CommandResult {
  return {
    command: [command, ...args],
    cwd: options?.cwd,
    stdout,
    stderr,
    exitCode,
  };
}
