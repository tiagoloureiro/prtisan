import { describe, expect, test } from "bun:test";

import { GitHubClient } from "@/github.js";
import {
  buildOpenPrGraph,
  descendantsOfOpenPr,
  loadOpenPrGraph,
  validationStatusFromPr,
} from "@/open-pr-graph.js";
import { VALIDATION_REVIEW_MARKER } from "@/review.js";

import { FakeRunner, issue, pullRequest } from "./helpers.js";

describe("open PR graph", () => {
  test("derives layers from PR base/head relationships", () => {
    const graph = buildOpenPrGraph(
      [
        { pr: pullRequest({ number: 1, headRefName: "a" }) },
        {
          pr: pullRequest({
            number: 2,
            headRefName: "b",
            baseRefName: "a",
          }),
        },
        {
          pr: pullRequest({
            number: 3,
            headRefName: "c",
            baseRefName: "b",
          }),
        },
      ],
      "main"
    );

    expect(graph.layers).toEqual([[1], [2], [3]]);
    expect(descendantsOfOpenPr(graph, 1)).toEqual([2, 3]);
  });

  test("derives blockers from linked issue dependencies", () => {
    const graph = buildOpenPrGraph(
      [
        {
          pr: pullRequest({
            number: 10,
            closingIssuesReferences: [{ number: 100 }],
          }),
          issue: issue({ number: 100, title: "Base" }),
        },
        {
          pr: pullRequest({
            number: 20,
            closingIssuesReferences: [{ number: 200 }],
          }),
          issue: issue({
            number: 200,
            title: "Dependent",
            blockedBy: [{ number: 100 }],
          }),
        },
      ],
      "main"
    );

    expect(graph.layers).toEqual([[10], [20]]);
    expect(graph.nodes.get(20)?.blockers).toEqual([10]);
  });

  test("loads all open PRs including drafts and enriches closing issue context", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      JSON.stringify([
        {
          number: 5,
          title: "Draft",
          body: "",
          state: "OPEN",
          isDraft: true,
          url: "https://github.com/o/r/pull/5",
          headRefName: "feature",
          baseRefName: "main",
          baseRefOid: "base",
          headRefOid: "head",
          closingIssuesReferences: [{ number: 50, title: "Spec" }],
          latestReviews: [],
          statusCheckRollup: [],
        },
      ])
    );
    runner.enqueue(
      JSON.stringify({
        number: 50,
        title: "Spec",
        body: "Do the thing",
        state: "OPEN",
        url: "https://github.com/o/r/issues/50",
        labels: [],
        blockedBy: [],
        blocking: [],
        parent: null,
        subIssues: [],
      })
    );

    const graph = await loadOpenPrGraph({
      github: new GitHubClient(runner, "/repo"),
      repo: "o/r",
      targetBranch: "main",
    });

    expect(runner.calls[0]?.args).toContain("--state");
    expect(runner.calls[0]?.args).toContain("open");
    expect(graph.nodes.get(5)?.pr.isDraft).toBe(true);
    expect(graph.nodes.get(5)?.issue?.number).toBe(50);
  });

  test("reads latest agent validation status from GitHub review bodies", () => {
    const status = validationStatusFromPr(
      pullRequest({
        latestReviews: [
          {
            state: "COMMENTED",
            body: `<!-- ${VALIDATION_REVIEW_MARKER} {"blockingFindings":0,"advisoryFindings":1,"specSkipped":true} -->`,
            submittedAt: "2026-07-23T00:00:00Z",
          },
        ],
      })
    );

    expect(status).toMatchObject({
      state: "commented",
      blockingFindings: 0,
      advisoryFindings: 1,
      specSkipped: true,
    });
  });
});
