import { describe, expect, test } from "bun:test";

import type { GitHubClient } from "@/github.js";
import { buildValidationPlan } from "@/validation-context.js";

import { issue, pullRequest } from "./helpers.js";

describe("validation context", () => {
  test("uses the primary closing issue for PR jobs and all closing issues for issue associations", async () => {
    const primary = issue({ number: 10, title: "Primary" });
    const secondary = issue({ number: 11, title: "Secondary" });
    const pr = pullRequest({
      number: 20,
      closingIssuesReferences: [{ number: 10 }, { number: 11 }],
    });

    const github = {
      listOpenPullRequests: async () => [pr],
      listOpenIssues: async () => [primary, secondary],
      getIssue: async (repo: string, issueNumber: number) => {
        expect(repo).toBe("o/r");
        return issueNumber === 10 ? primary : secondary;
      },
    } as unknown as GitHubClient;

    const plan = await buildValidationPlan({
      github,
      repo: "o/r",
      targetBranch: "main",
    });

    expect(plan.pullRequestJobs[0]?.issue?.number).toBe(10);
    expect(
      plan.issueJobs.map((job) => [
        job.issue.number,
        job.associatedOpenPullRequests.map((item) => item.number),
      ])
    ).toEqual([
      [10, [20]],
      [11, [20]],
    ]);
  });

  test("limits related issue loading while building issue jobs", async () => {
    const issues = Array.from({ length: 5 }, (_, index) =>
      issue({
        number: index + 1,
        title: `Issue ${index + 1}`,
        blockedBy: [{ number: index + 101 }],
      })
    );
    let activeRequests = 0;
    let maxActiveRequests = 0;

    const github = {
      listOpenPullRequests: async () => [],
      listOpenIssues: async () => issues,
      getIssue: async (_repo: string, issueNumber: number) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await Bun.sleep(5);
        activeRequests -= 1;
        return issue({ number: issueNumber, title: `Related ${issueNumber}` });
      },
    } as unknown as GitHubClient;

    const plan = await buildValidationPlan({
      github,
      repo: "o/r",
      targetBranch: "main",
      concurrency: 2,
    });

    expect(plan.issueJobs).toHaveLength(5);
    expect(maxActiveRequests).toBeLessThanOrEqual(2);
  });
});
