import { describe, expect, test } from "bun:test";

import { executeMerge } from "@/commands/merge.js";
import type { GitClient } from "@/git.js";
import type { GitHubClient } from "@/github.js";
import { VALIDATION_REVIEW_MARKER } from "@/review.js";

import { pullRequest, testConfig } from "./helpers.js";

describe("merge command", () => {
  test("stops on draft PRs in topological order", async () => {
    const draft = pullRequest({
      number: 4,
      isDraft: true,
      latestReviews: [
        {
          state: "COMMENTED",
          body: `<!-- ${VALIDATION_REVIEW_MARKER} {"blockingFindings":0,"advisoryFindings":0,"specSkipped":true} -->`,
        },
      ],
    });
    const github = {
      listOpenPullRequests: async () => [draft],
    } as unknown as GitHubClient;
    const git = {} as unknown as GitClient;

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        { github, git }
      )
    ).rejects.toThrow("PR #4 is still a draft.");
  });

  test("reports all blockers for the next PR in the merge train", async () => {
    const blocked = pullRequest({
      number: 117,
      isDraft: true,
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          name: "check",
          status: "COMPLETED",
        },
      ],
    });
    const github = {
      listOpenPullRequests: async () => [blocked],
    } as unknown as GitHubClient;
    const git = {} as unknown as GitClient;

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        { github, git }
      )
    ).rejects.toThrow(
      [
        "PR #117 is not ready to merge:",
        "- PR #117 has no agent-train validation review yet.",
        "- PR #117 is still a draft.",
        "- PR #117 has 1 non-green status check(s).",
      ].join("\n")
    );
  });
});
