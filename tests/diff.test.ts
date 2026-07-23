import { describe, expect, test } from "bun:test";

import { preparePullRequestReview } from "@/review.js";
import type { ReviewFinding } from "@/types.js";

import { pullRequest } from "./helpers.js";

const diff = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
@@ -10,2 +11,2 @@
 const later = true;
+const added = true;
`;

describe("review preparation", () => {
  test("maps findings on new and old lines to GitHub review comments", () => {
    const pr = pullRequest({
      number: 1,
      url: "",
      title: "",
      headRefName: "h",
      baseRefName: "b",
      headRefOid: "sha",
    });
    const findings: ReviewFinding[] = [
      {
        axis: "spec",
        severity: "blocking",
        title: "Old line",
        body: "The removed line is wrong.",
        path: "src/a.ts",
        line: 2,
        side: "LEFT",
      },
      {
        axis: "spec",
        severity: "blocking",
        title: "New line",
        body: "The added line is wrong.",
        path: "src/a.ts",
        line: 3,
      },
      {
        axis: "spec",
        severity: "blocking",
        title: "Later line",
        body: "The later added line is wrong.",
        path: "src/a.ts",
        line: 12,
      },
    ];

    const review = preparePullRequestReview({ pr, diff, findings });

    expect(review.comments.map((comment) => comment.position)).toEqual([
      2, 4, 7,
    ]);
    expect(review.summaryCount).toBe(0);
  });

  test("keeps unmappable findings in review body", () => {
    const pr = pullRequest({
      number: 1,
      url: "",
      title: "",
      headRefName: "h",
      baseRefName: "b",
      headRefOid: "sha",
    });
    const findings: ReviewFinding[] = [
      {
        axis: "spec",
        severity: "blocking",
        title: "Wrong line",
        body: "This line is not in the diff.",
        path: "src/a.ts",
        line: 99,
      },
    ];

    const review = preparePullRequestReview({ pr, diff, findings });
    expect(review.event).toBe("REQUEST_CHANGES");
    expect(review.body).toContain('"headRefOid":"sha"');
    expect(review.comments).toHaveLength(0);
    expect(review.summaryCount).toBe(1);
  });
});
