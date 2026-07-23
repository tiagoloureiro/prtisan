import { describe, expect, test } from "bun:test";

import type { AgentRunner } from "@/agent.js";
import { issueRepairBranch } from "@/branching.js";
import { executeValidate } from "@/commands/validate.js";
import type { GitClient } from "@/git.js";
import type {
  CreateOrUpdatePrInput,
  GitHubClient,
  PullRequestReviewInput,
} from "@/github.js";
import type { ReviewFinding } from "@/types.js";

import { issue, pullRequest, testConfig } from "./helpers.js";

const blockingSpecFinding: ReviewFinding = {
  axis: "spec",
  severity: "blocking",
  title: "Missing behavior",
  body: "The target branch does not implement the required behavior.",
  path: "src/a.ts",
  line: 12,
};

describe("validate command", () => {
  test("runs Standards only for PRs without linked closing issues", async () => {
    const pr = pullRequest({ number: 12, headRefName: "feature" });
    const reviewCalls: string[] = [];
    let postedReview: PullRequestReviewInput | undefined;

    const github = {
      listOpenPullRequests: async () => [pr],
      listOpenIssues: async () => [],
      getPullRequest: async () => pr,
      getPullRequestDiff: async () => "diff --git a/a.ts b/a.ts",
      createPullRequestReview: async (input: PullRequestReviewInput) => {
        postedReview = input;
      },
    } as unknown as GitHubClient;
    const git = gitClient();
    const agent = fakeAgent({
      onReviewPullRequest: (input) => reviewCalls.push(input.axis),
    });

    const result = await executeValidate(
      { cwd: "/repo", config: testConfig(), runId: "validate-test" },
      { github, git, agent }
    );

    expect(reviewCalls).toEqual(["standards"]);
    expect(result.pullRequests[0]).toMatchObject({
      pr: { number: 12 },
      specSkipped: true,
      status: "validated",
    });
    expect(result.issues).toEqual([]);
    expect(postedReview?.body).toContain('"specSkipped":true');
  });

  test("skips the issue sweep when validating selected PRs", async () => {
    const pr = pullRequest({ number: 12, headRefName: "feature" });

    const github = {
      listOpenPullRequests: async () => [pr],
      listOpenIssues: async () => {
        throw new Error("should not load issues for selected PR validation");
      },
      getPullRequest: async () => pr,
      getPullRequestDiff: async () => "diff --git a/a.ts b/a.ts",
      createPullRequestReview: async () => {},
    } as unknown as GitHubClient;

    const result = await executeValidate(
      {
        cwd: "/repo",
        config: testConfig(),
        pullNumbers: [12],
        runId: "validate-test",
      },
      { github, git: gitClient(), agent: fakeAgent() }
    );

    expect(result.pullRequests).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  test("loads all open issues and validates the target branch against each issue", async () => {
    const openIssues = [
      issue({ number: 1, title: "First" }),
      issue({ number: 2, title: "Second" }),
    ];
    const reviewedIssues: number[] = [];
    const comments: { issueNumber: number; body: string }[] = [];

    const github = {
      listOpenPullRequests: async () => [],
      listOpenIssues: async () => openIssues,
      createIssueComment: async (
        _repo: string,
        issueNumber: number,
        body: string
      ) => {
        comments.push({ issueNumber, body });
      },
    } as unknown as GitHubClient;
    const agent = fakeAgent({
      onReviewIssueBranch: (input) => reviewedIssues.push(input.issue.number),
    });

    const result = await executeValidate(
      { cwd: "/repo", config: testConfig(), runId: "validate-test" },
      { github, git: gitClient(), agent }
    );

    expect(reviewedIssues.toSorted()).toEqual([1, 2]);
    expect(comments.map((comment) => comment.issueNumber).toSorted()).toEqual([
      1, 2,
    ]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toMatchObject({
      status: "validated",
      blockingFindings: 0,
      commentPosted: true,
    });
  });

  test("validates both the associated open PR and the target branch for an issue", async () => {
    const primaryIssue = issue({ number: 10, title: "Spec" });
    const pr = pullRequest({
      number: 20,
      headRefName: "feature",
      closingIssuesReferences: [{ number: primaryIssue.number }],
    });
    const prReviewAxes: string[] = [];
    const issueReviews: number[] = [];
    let postedPrReview: PullRequestReviewInput | undefined;
    const comments: string[] = [];

    const github = {
      listOpenPullRequests: async () => [pr],
      listOpenIssues: async () => [primaryIssue],
      getIssue: async () => primaryIssue,
      getPullRequest: async () => pr,
      getPullRequestDiff: async () => "diff --git a/a.ts b/a.ts",
      createPullRequestReview: async (input: PullRequestReviewInput) => {
        postedPrReview = input;
      },
      createIssueComment: async (
        _repo: string,
        _issueNumber: number,
        body: string
      ) => {
        comments.push(body);
      },
    } as unknown as GitHubClient;
    const agent = fakeAgent({
      onReviewPullRequest: (input) => prReviewAxes.push(input.axis),
      onReviewIssueBranch: (input) => issueReviews.push(input.issue.number),
    });

    const result = await executeValidate(
      { cwd: "/repo", config: testConfig(), runId: "validate-test" },
      { github, git: gitClient(), agent }
    );

    expect(prReviewAxes).toEqual(["standards", "spec"]);
    expect(issueReviews).toEqual([10]);
    expect(postedPrReview?.pullNumber).toBe(20);
    expect(comments).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({ issueNumber: 10 });
    expect(result.issues[0]).toMatchObject({
      issue: { number: 10 },
      associatedOpenPullRequests: [{ number: 20 }],
    });
  });

  test("posts repair follow-up validation against the pushed repair head", async () => {
    const originalPr = pullRequest({
      number: 12,
      headRefName: "feature",
      headRefOid: "old-head",
    });
    const repairedPr = pullRequest({
      ...originalPr,
      headRefOid: "repair-sha",
    });
    const gitCalls: string[] = [];
    let getPullRequestCalls = 0;
    let postedReview: PullRequestReviewInput | undefined;

    const github = {
      listOpenPullRequests: async () => [originalPr],
      listOpenIssues: async () => [],
      getPullRequest: async () => {
        getPullRequestCalls += 1;
        return getPullRequestCalls === 1 ? originalPr : repairedPr;
      },
      getPullRequestDiff: async () => "diff --git a/a.ts b/a.ts",
      createPullRequestReview: async (input: PullRequestReviewInput) => {
        postedReview = input;
      },
    } as unknown as GitHubClient;

    await executeValidate(
      { cwd: "/repo", config: testConfig(), runId: "validate-test" },
      {
        github,
        git: gitClient(gitCalls),
        agent: fakeAgent({
          pullRequestFindings: [[blockingSpecFinding], []],
          repairPullRequestCommits: ["repair-sha"],
        }),
      }
    );

    expect(gitCalls).toContain("push:feature");
    expect(postedReview?.commitId).toBe("repair-sha");
    expect(postedReview?.body).toContain('"headRefOid":"repair-sha"');
  });

  test("does not create a duplicate repair PR when main has blocking gaps but an associated PR is open", async () => {
    const primaryIssue = issue({ number: 30, title: "Spec" });
    const pr = pullRequest({
      number: 40,
      url: "https://github.com/o/r/pull/40",
      closingIssuesReferences: [{ number: primaryIssue.number }],
    });
    const comments: string[] = [];

    const github = {
      listOpenPullRequests: async () => [pr],
      listOpenIssues: async () => [primaryIssue],
      getIssue: async () => primaryIssue,
      getPullRequest: async () => pr,
      getPullRequestDiff: async () => "diff --git a/a.ts b/a.ts",
      createPullRequestReview: async () => {},
      createIssueComment: async (
        _repo: string,
        _issueNumber: number,
        body: string
      ) => {
        comments.push(body);
      },
      createOrUpdatePullRequest: async () => {
        throw new Error("should not create a repair PR");
      },
    } as unknown as GitHubClient;
    const agent = fakeAgent({
      issueBranchFindings: [blockingSpecFinding],
      onRepairIssueBranch: () => {
        throw new Error("should not repair an issue branch");
      },
    });

    const result = await executeValidate(
      { cwd: "/repo", config: testConfig(), runId: "validate-test" },
      { github, git: gitClient(), agent }
    );

    expect(result.issues[0]).toMatchObject({
      status: "validation_failed",
      blockingFindings: 1,
      repaired: false,
      repairPullRequest: undefined,
      associatedOpenPullRequests: [{ number: 40 }],
    });
    expect(comments[0]).toContain("Existing open PR(s)");
    expect(comments[0]).toContain("#40");
  });

  test("creates a repair PR when main has blocking gaps and no associated PR is open", async () => {
    const primaryIssue = issue({ number: 7, title: "Missing feature" });
    const repairPr = pullRequest({
      number: 99,
      url: "https://github.com/o/r/pull/99",
      headRefName: issueRepairBranch(primaryIssue.number),
    });
    const gitCalls: string[] = [];
    const comments: string[] = [];
    let createdPrInput: CreateOrUpdatePrInput | undefined;
    let repairedBranch: string | undefined;

    const github = {
      listOpenPullRequests: async () => [],
      listOpenIssues: async () => [primaryIssue],
      createIssueComment: async (
        _repo: string,
        _issueNumber: number,
        body: string
      ) => {
        comments.push(body);
      },
      createOrUpdatePullRequest: async (input: CreateOrUpdatePrInput) => {
        createdPrInput = input;
        return repairPr;
      },
    } as unknown as GitHubClient;
    const agent = fakeAgent({
      issueBranchFindings: [blockingSpecFinding],
      repairIssueCommits: ["repair-sha"],
      onRepairIssueBranch: (input) => {
        repairedBranch = input.branch;
      },
    });

    const result = await executeValidate(
      { cwd: "/repo", config: testConfig(), runId: "validate-test" },
      { github, git: gitClient(gitCalls), agent }
    );

    expect(repairedBranch).toBe("agent-train/repair/issue-7");
    expect(gitCalls).toContain("prepare:agent-train/repair/issue-7:main");
    expect(gitCalls).toContain("push:agent-train/repair/issue-7");
    expect(createdPrInput).toMatchObject({
      repo: "o/r",
      baseBranch: "main",
      headBranch: "agent-train/repair/issue-7",
    });
    expect(result.issues[0]).toMatchObject({
      repaired: true,
      repairPullRequest: { number: 99 },
    });
    expect(comments[0]).toContain("Created or updated repair PR");
    expect(comments[0]).toContain("#99");
  });

  test("does not create a repair PR for main gaps when repair is disabled", async () => {
    const primaryIssue = issue({ number: 8, title: "Missing feature" });
    const comments: string[] = [];

    const github = {
      listOpenPullRequests: async () => [],
      listOpenIssues: async () => [primaryIssue],
      createIssueComment: async (
        _repo: string,
        _issueNumber: number,
        body: string
      ) => {
        comments.push(body);
      },
      createOrUpdatePullRequest: async () => {
        throw new Error("should not create a repair PR");
      },
    } as unknown as GitHubClient;
    const agent = fakeAgent({
      issueBranchFindings: [blockingSpecFinding],
      onRepairIssueBranch: () => {
        throw new Error("should not repair an issue branch");
      },
    });

    const result = await executeValidate(
      {
        cwd: "/repo",
        config: testConfig(),
        repair: false,
        runId: "validate-test",
      },
      { github, git: gitClient(), agent }
    );

    expect(result.issues[0]).toMatchObject({
      status: "validation_failed",
      repaired: false,
      repairPullRequest: undefined,
    });
    expect(comments[0]).toContain("Repair is disabled");
  });
});

function gitClient(calls: string[] = []): GitClient {
  return {
    fetchBranch: async (branch: string) => {
      calls.push(`fetch:${branch}`);
    },
    prepareBranchFromBase: async (branch: string, baseBranch: string) => {
      calls.push(`prepare:${branch}:${baseBranch}`);
    },
    pushBranch: async (branch: string) => {
      calls.push(`push:${branch}`);
    },
  } as unknown as GitClient;
}

function fakeAgent(
  options: {
    readonly issueBranchFindings?: readonly ReviewFinding[];
    readonly pullRequestFindings?: readonly (readonly ReviewFinding[])[];
    readonly repairIssueCommits?: readonly string[];
    readonly repairPullRequestCommits?: readonly string[];
    readonly onReviewPullRequest?: (
      input: Extract<
        Parameters<AgentRunner["review"]>[0],
        { kind: "pull-request" }
      >
    ) => void;
    readonly onReviewIssueBranch?: (
      input: Extract<
        Parameters<AgentRunner["review"]>[0],
        { kind: "issue-branch" }
      >
    ) => void;
    readonly onRepairIssueBranch?: (
      input: Extract<
        Parameters<AgentRunner["repair"]>[0],
        { kind: "issue-branch" }
      >
    ) => void;
  } = {}
): AgentRunner {
  let pullRequestReviewCalls = 0;
  return {
    review: async (input) => {
      if (input.kind === "pull-request") {
        const findings =
          options.pullRequestFindings?.[pullRequestReviewCalls] ?? [];
        pullRequestReviewCalls += 1;
        options.onReviewPullRequest?.(input);
        return { axis: input.axis, summary: "", findings };
      }

      options.onReviewIssueBranch?.(input);
      return {
        axis: "spec",
        summary: "",
        findings: options.issueBranchFindings ?? [],
      };
    },
    repair: async (input) => {
      if (input.kind === "issue-branch") {
        options.onRepairIssueBranch?.(input);
        return {
          branch: input.branch,
          commits: options.repairIssueCommits ?? [],
          stdout: "",
        };
      }

      return {
        branch: input.branch,
        commits: options.repairPullRequestCommits ?? [],
        stdout: "",
      };
    },
  };
}
