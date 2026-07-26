import { describe, expect, test } from "bun:test";

import {
  buildCiRepairPrompt,
  buildIssueBranchReviewPrompt,
  buildMergeStateRepairPrompt,
  buildReviewPrompt,
} from "@/prompts.js";

import { issue } from "./helpers.js";

describe("prompts", () => {
  test("review prompt requests tagged JSON and includes direct related issues", () => {
    const prompt = buildReviewPrompt({
      axis: "spec",
      issue: issue({ number: 10, title: "Primary", body: "Build the thing." }),
      relatedIssues: [
        issue({ number: 9, title: "Blocker", body: "Create the base." }),
      ],
      prNumber: 20,
      branch: "agent/issue-10-primary",
      baseBranch: "agent/issue-9-blocker",
      diff: "diff --git a/a b/a",
    });

    expect(prompt).toContain("<review>");
    expect(prompt).toContain("$code-review");
    expect(prompt).toContain("#9 Blocker");
    expect(prompt).not.toContain("Create the base.");
    expect(prompt).toContain("git diff");
    expect(prompt).not.toContain("diff --git a/a b/a");
  });

  test("issue branch review prompt validates repository state without a PR diff", () => {
    const prompt = buildIssueBranchReviewPrompt({
      issue: issue({ number: 10, title: "Primary", body: "Build the thing." }),
      relatedIssues: [
        issue({ number: 9, title: "Blocker", body: "Create the base." }),
      ],
      targetBranch: "main",
    });

    expect(prompt).toContain("validating target branch main");
    expect(prompt).toContain("Review only the Spec axis.");
    expect(prompt).toContain("#9 Blocker");
    expect(prompt).not.toContain("Create the base.");
    expect(prompt).not.toContain("PR diff:");
  });

  test("CI repair prompt includes failed check evidence", () => {
    const prompt = buildCiRepairPrompt({
      issue: issue({ number: 10, title: "Primary", body: "Build the thing." }),
      relatedIssues: [],
      prNumber: 20,
      branch: "agent/issue-10-primary",
      baseBranch: "main",
      checkEvidence: [
        {
          name: "check",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/o/r/actions/runs/123",
          logExcerpt: "Expected true to be false",
        },
      ],
    });

    expect(prompt).toContain("because GitHub checks failed");
    expect(prompt).toContain("Expected true to be false");
    expect(prompt).toContain("Fix only clear causes");
  });

  test("merge-state repair prompt includes blockers and human-review boundary", () => {
    const prompt = buildMergeStateRepairPrompt({
      relatedIssues: [],
      prNumber: 20,
      branch: "agent/issue-10-primary",
      baseBranch: "main",
      mergeState: "DIRTY",
      blockers: ["PR #20 is not mergeable yet (DIRTY)."],
    });

    expect(prompt).toContain("merge state DIRTY");
    expect(prompt).toContain("PR #20 is not mergeable yet");
    expect(prompt).toContain("Do not attempt to satisfy required human review");
  });
});
