import { describe, expect, test } from "bun:test";

import { buildReviewPrompt } from "@/prompts.js";

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
    expect(prompt).toContain("Issue #9");
    expect(prompt).toContain("PR diff:");
  });
});
