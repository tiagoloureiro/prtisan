import { describe, expect, test } from "bun:test";

import type { AgentRunner } from "@/agent.js";
import { executeValidate } from "@/commands/validate.js";
import type { GitClient } from "@/git.js";
import type { GitHubClient, PullRequestReviewInput } from "@/github.js";

import { pullRequest, testConfig } from "./helpers.js";

describe("validate command", () => {
  test("runs Standards only for PRs without linked closing issues", async () => {
    const pr = pullRequest({ number: 12, headRefName: "feature" });
    const reviewCalls: string[] = [];
    let postedReview: PullRequestReviewInput | undefined;

    const github = {
      listOpenPullRequests: async () => [pr],
      getPullRequest: async () => pr,
      getPullRequestDiff: async () => "diff --git a/a.ts b/a.ts",
      createPullRequestReview: async (input: PullRequestReviewInput) => {
        postedReview = input;
      },
    } as unknown as GitHubClient;
    const git = {
      prepareBranchFromBase: async () => {},
      pushBranch: async () => {},
    } as unknown as GitClient;
    const agent: AgentRunner = {
      reviewPullRequest: async (input) => {
        reviewCalls.push(input.axis);
        return { axis: input.axis, summary: "", findings: [] };
      },
      repairPullRequest: async () => ({
        branch: pr.headRefName,
        commits: [],
        stdout: "",
      }),
    };

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
    expect(postedReview?.body).toContain('"specSkipped":true');
  });
});
