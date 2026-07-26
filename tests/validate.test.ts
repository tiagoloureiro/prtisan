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
import type {
  PreparedRuntime,
  RuntimeProvider,
  VerificationRunner,
} from "@/runtime.js";
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
      {
        cwd: "/repo",
        config: testConfig(),
        runId: "validate-test",
      },
      validationDeps(github, git, agent)
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
      validationDeps(github, gitClient(), fakeAgent())
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
      {
        cwd: "/repo",
        config: testConfig(),
        runId: "validate-test",
        scope: "issues",
      },
      validationDeps(github, gitClient(), agent)
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

  test("does not duplicate target-branch issue validation for an issue represented by an open PR", async () => {
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
      {
        cwd: "/repo",
        config: testConfig(),
        runId: "validate-test",
        scope: "all",
      },
      validationDeps(github, gitClient(), agent)
    );

    expect(prReviewAxes).toEqual(["standards", "spec"]);
    expect(issueReviews).toEqual([]);
    expect(postedPrReview?.pullNumber).toBe(20);
    expect(comments).toHaveLength(0);
    expect(result.pullRequests[0]).toMatchObject({ issueNumber: 10 });
    expect(result.issues).toEqual([]);
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
    let pushed = false;
    let postedReview: PullRequestReviewInput | undefined;

    const github = {
      listOpenPullRequests: async () => [originalPr],
      listOpenIssues: async () => [],
      getPullRequest: async () => (pushed ? repairedPr : originalPr),
      getPullRequestDiff: async () => "diff --git a/a.ts b/a.ts",
      createPullRequestReview: async (input: PullRequestReviewInput) => {
        postedReview = input;
      },
    } as unknown as GitHubClient;

    await executeValidate(
      { cwd: "/repo", config: testConfig(), runId: "validate-test" },
      validationDeps(
        github,
        gitClient(gitCalls, {
          onPushVerified: () => {
            pushed = true;
          },
        }),
        fakeAgent({
          pullRequestFindings: [[blockingSpecFinding], []],
          repairPullRequestCommits: ["repair-sha"],
        })
      )
    );

    expect(gitCalls).toContain("push-verified:feature:repair-sha:old-head");
    expect(postedReview?.commitId).toBe("repair-sha");
    expect(postedReview?.body).toContain('"headRefOid":"repair-sha"');
  });

  test("skips issue repair when an associated open PR already represents the issue", async () => {
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
      {
        cwd: "/repo",
        config: testConfig(),
        runId: "validate-test",
        scope: "all",
      },
      validationDeps(github, gitClient(), agent)
    );

    expect(result.issues).toEqual([]);
    expect(comments).toEqual([]);
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
    const preparedRefs: string[] = [];
    const verifiedRuntimeFingerprints: string[] = [];

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

    const deps = validationDeps(github, gitClient(gitCalls), agent);
    const result = await executeValidate(
      {
        cwd: "/repo",
        config: testConfig(),
        runId: "validate-test",
        scope: "issues",
      },
      {
        ...deps,
        runtime: {
          prepare: async (input) => {
            preparedRefs.push(input.ref);
            return {
              ...preparedRuntime,
              fingerprint: `runtime-${input.ref}`,
            };
          },
        },
        verification: {
          verify: async (input) => {
            verifiedRuntimeFingerprints.push(input.runtime.fingerprint);
            return { status: "passed", commands: [] };
          },
        },
      }
    );

    expect(repairedBranch).toBe("agent-train/repair/issue-7");
    expect(gitCalls).toContain(
      "prepare-at:agent-train/repair/issue-7:base-sha"
    );
    expect(gitCalls).toContain(
      "push-verified:agent-train/repair/issue-7:repair-sha:"
    );
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
    expect(preparedRefs).toEqual(["base-sha", "repair-sha"]);
    expect(verifiedRuntimeFingerprints).toEqual(["runtime-repair-sha"]);
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
        scope: "issues",
      },
      validationDeps(github, gitClient(), agent)
    );

    expect(result.issues[0]).toMatchObject({
      status: "validation_failed",
      repaired: false,
      repairPullRequest: undefined,
    });
    expect(comments[0]).toContain("Repair is disabled");
  });
});

function gitClient(
  calls: string[] = [],
  options: { readonly onPushVerified?: () => void } = {}
): GitClient {
  return {
    fetchBranch: async (branch: string) => {
      calls.push(`fetch:${branch}`);
    },
    revParseRemoteBranch: async (branch: string) => {
      calls.push(`rev-parse:${branch}`);
      return "base-sha";
    },
    branchExistsOnRemote: async (branch: string) => {
      calls.push(`remote-exists:${branch}`);
      return false;
    },
    prepareBranchFromBase: async (branch: string, baseBranch: string) => {
      calls.push(`prepare:${branch}:${baseBranch}`);
    },
    pushBranch: async (branch: string) => {
      calls.push(`push:${branch}`);
    },
    prepareBranchAt: async (branch: string, startPoint: string) => {
      calls.push(`prepare-at:${branch}:${startPoint}`);
    },
    pushVerifiedCommit: async (input: {
      readonly branch: string;
      readonly commit: string;
      readonly expectedRemoteSha: string;
    }) => {
      calls.push(
        `push-verified:${input.branch}:${input.commit}:${input.expectedRemoteSha}`
      );
      options.onPushVerified?.();
    },
    deleteLocalBranch: async (branch: string) => {
      calls.push(`delete-local:${branch}`);
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
          structuredOutput: {
            addressedFindingIds: input.findings
              .map((finding) => finding.findingId)
              .filter(Boolean),
            changedPaths: ["src/a.ts"],
            summary: "",
            limitations: [],
          },
        };
      }

      const addressedFindingIds =
        input.kind === "pull-request"
          ? input.findings.map((finding) => finding.findingId).filter(Boolean)
          : [];
      return {
        branch: input.branch,
        commits: options.repairPullRequestCommits ?? [],
        stdout: "",
        structuredOutput: {
          addressedFindingIds,
          changedPaths: ["src/a.ts"],
          summary: "",
          limitations: [],
        },
      };
    },
    verifyRepair: async (input) => ({
      summary: "",
      resolvedFindingIds: input.findings
        .map((finding) => finding.findingId)
        .filter((id): id is string => Boolean(id)),
      findings: [],
    }),
  };
}

const preparedRuntime: PreparedRuntime = {
  imageName: "test-runtime",
  fingerprint: "test-runtime-fingerprint",
  profile: {
    kind: "image",
    verification: [],
    probes: [],
    fingerprint: "test-runtime-profile",
  },
  verification: [],
  probes: [],
};

function validationDeps(
  github: GitHubClient,
  git: GitClient,
  agent: AgentRunner
): {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly agent: AgentRunner;
  readonly runtime: RuntimeProvider;
  readonly verification: VerificationRunner;
} {
  return {
    github,
    git,
    agent,
    runtime: {
      prepare: async () => preparedRuntime,
    },
    verification: {
      verify: async () => ({ status: "passed", commands: [] }),
    },
  };
}
