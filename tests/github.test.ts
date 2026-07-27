import { describe, expect, test } from "bun:test";

import type { CommandOptions, CommandResult } from "@/exec.js";
import {
  actionablePullRequestCheckEvidence,
  ciFailureFingerprint,
  GitHubClient,
  isPullRequestGreen,
  managedCommentSection,
  pullRequestCheckStatus,
  sanitizeGitHubText,
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

  test("waits for checks on the pushed commit instead of accepting a stale PR rollup", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      JSON.stringify({
        ...pullRequest({
          headRefOid: "old-head",
          statusCheckRollup: [
            {
              name: "test",
              status: "COMPLETED",
              conclusion: "FAILURE",
            },
          ],
        }),
      })
    );
    runner.enqueue(
      JSON.stringify({
        ...pullRequest({
          headRefOid: "new-head",
          statusCheckRollup: [
            {
              name: "test",
              status: "COMPLETED",
              conclusion: "FAILURE",
            },
          ],
        }),
      })
    );
    runner.enqueue(
      JSON.stringify({
        check_runs: [
          {
            name: "test",
            status: "in_progress",
            details_url: "https://github.com/o/r/actions/runs/201",
          },
        ],
      })
    );
    runner.enqueue(JSON.stringify({ statuses: [] }));
    runner.enqueue(
      JSON.stringify({
        ...pullRequest({
          headRefOid: "new-head",
          statusCheckRollup: [],
        }),
      })
    );
    runner.enqueue(
      JSON.stringify({
        check_runs: [
          {
            name: "test",
            status: "completed",
            conclusion: "success",
            details_url: "https://github.com/o/r/actions/runs/202",
          },
        ],
      })
    );
    runner.enqueue(JSON.stringify({ statuses: [] }));

    const settled = await new GitHubClient(
      runner,
      "/repo"
    ).waitForPullRequestChecks("o/r", 1, 200, 1, {
      headRefOid: "new-head",
      expectedCheckNames: ["test"],
      startGraceMs: 1,
    });

    expect(settled.headRefOid).toBe("new-head");
    expect(pullRequestCheckStatus(settled).successful).toEqual([
      expect.objectContaining({ name: "test", runId: "202" }),
    ]);
    expect(
      runner.calls.filter(
        (call) =>
          call.command === "gh" &&
          call.args.includes(
            "/repos/o/r/commits/new-head/check-runs?per_page=100"
          )
      )
    ).toHaveLength(2);
  });

  test("reads required status contexts from branch protection when available", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      JSON.stringify({
        contexts: ["lint"],
        checks: [{ context: "test", app_id: 1 }],
      })
    );

    expect(
      await new GitHubClient(runner, "/repo").getRequiredCheckNames(
        "o/r",
        "release/next"
      )
    ).toEqual(["lint", "test"]);
    expect(runner.calls[0]?.args).toContain(
      "/repos/o/r/branches/release%2Fnext/protection/required_status_checks"
    );
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

  test("qualifies only completed code failures with fetched logs", () => {
    const evidence = actionablePullRequestCheckEvidence(
      [
        {
          name: "cancelled",
          status: "COMPLETED",
          conclusion: "CANCELLED",
          runId: "1",
          logExcerpt: "cancelled",
        },
        {
          name: "startup",
          status: "COMPLETED",
          conclusion: "STARTUP_FAILURE",
          runId: "2",
          logExcerpt: "runner unavailable",
        },
        {
          name: "external",
          status: "COMPLETED",
          conclusion: "FAILURE",
          logExcerpt: "external summary only",
        },
        {
          name: "fetch-error",
          status: "COMPLETED",
          conclusion: "FAILURE",
          runId: "3",
          logError: "forbidden",
        },
        {
          name: "missing-toolchain",
          status: "COMPLETED",
          conclusion: "FAILURE",
          runId: "5",
          logExcerpt: "pnpm: command not found",
        },
        {
          name: "missing-docker",
          status: "COMPLETED",
          conclusion: "FAILURE",
          runId: "6",
          logExcerpt: "Docker is required to run Playwright e2e tests.",
        },
        {
          name: "actionable",
          status: "COMPLETED",
          conclusion: "FAILURE",
          runId: "4",
          logExcerpt:
            "AWS_SECRET_ACCESS_KEY=super-secret-value\n/home/tiago/titally/src/a.ts failed",
        },
      ],
      { maxLogChars: 200, maxTotalChars: 200 }
    );

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.name).toBe("actionable");
    expect(evidence[0]?.logExcerpt).toContain(
      "AWS_SECRET_ACCESS_KEY=[REDACTED]"
    );
    expect(evidence[0]?.logExcerpt).not.toContain("super-secret-value");
  });

  test("fingerprints normalized CI evidence by head and run identity", () => {
    const first = ciFailureFingerprint("head-a", [
      {
        name: "check",
        status: "COMPLETED",
        conclusion: "FAILURE",
        runId: "101",
        logExcerpt:
          "2026-07-26T12:30:00Z TOKEN=secret-value assertion 0xabc12345",
      },
    ]);
    const normalizedEquivalent = ciFailureFingerprint("head-a", [
      {
        name: "check",
        status: "COMPLETED",
        conclusion: "FAILURE",
        runId: "101",
        logExcerpt:
          "2026-07-26T12:31:00Z TOKEN=another-secret assertion 0xdef67890",
      },
    ]);
    const differentRun = ciFailureFingerprint("head-a", [
      {
        name: "check",
        status: "COMPLETED",
        conclusion: "FAILURE",
        runId: "102",
        logExcerpt: "assertion",
      },
    ]);

    expect(normalizedEquivalent).toBe(first);
    expect(differentRun).not.toBe(first);
  });

  test("removes host filesystem paths from GitHub-bound text", () => {
    expect(
      sanitizeGitHubText(
        "See /home/tiago/titally/src/a.ts and /tmp/prtisan-run/log.txt"
      )
    ).toBe("See [local workspace path] and [temporary path]");
  });

  test("creates a new PR when a matching branch only has closed PRs", async () => {
    const runner = new ClosedBranchPrRunner();
    const client = new GitHubClient(runner, "/repo");

    const pr = await client.createOrUpdatePullRequest({
      repo: "o/r",
      title: "Configure Prtisan",
      body: "body",
      baseBranch: "main",
      headBranch: "prtisan/setup",
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

  test("updates the one managed PR summary comment in place", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      JSON.stringify([{ id: 42, body: "<!-- prtisan:summary -->\nold status" }])
    );
    runner.enqueue("");

    await new GitHubClient(runner, "/repo").upsertPullRequestComment(
      "o/r",
      117,
      "prtisan:summary",
      "<!-- prtisan:summary -->\nnew status"
    );

    expect(runner.calls[1]?.args).toContain("/repos/o/r/issues/comments/42");
    expect(runner.calls[1]?.args).toContain("PATCH");
  });

  test("classifies Titally runner prerequisites as external", () => {
    const actionable = actionablePullRequestCheckEvidence(
      [
        {
          name: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          runId: "9001",
          logExcerpt:
            "sudo: a password is required\nsudo: timed out reading password",
        },
        {
          name: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          runId: "9002",
          logExcerpt:
            "node: error while loading shared libraries: libatomic.so.1: cannot open shared object file",
        },
      ],
      { maxLogChars: 10_000, maxTotalChars: 10_000 }
    );

    expect(actionable).toEqual([]);
  });

  test("preserves independently managed workflow and validation sections", () => {
    const body = [
      "<!-- prtisan:summary -->",
      "<!-- prtisan:workflow:start -->",
      "workflow state",
      "<!-- prtisan:workflow:end -->",
      "<!-- prtisan:validation:start -->",
      "validation evidence",
      "<!-- prtisan:validation:end -->",
    ].join("\n");

    expect(managedCommentSection([{ body }], "workflow")).toContain(
      "workflow state"
    );
    expect(managedCommentSection([{ body }], "validation")).toContain(
      "validation evidence"
    );
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
                  headRefName: "prtisan/setup",
                  headRefOid: "new-sha",
                }),
              ]
            : []
          : [
              pullRequest({
                number: 210,
                state: "CLOSED",
                headRefName: "prtisan/setup",
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
    args[args.indexOf("--head") + 1] === "prtisan/setup"
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
