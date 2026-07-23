import { describe, expect, test } from "bun:test";

import { findDiffPosition, parseUnifiedDiff } from "@/diff.js";
import { preparePullRequestReview } from "@/review.js";
import type { PullRequest, ReviewFinding } from "@/types.js";

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

describe("diff mapping", () => {
  test("maps new and old lines to GitHub diff positions", () => {
    const lines = parseUnifiedDiff(diff);

    expect(
      findDiffPosition(lines, { path: "src/a.ts", line: 2, side: "LEFT" })
    ).toBe(2);
    expect(
      findDiffPosition(lines, { path: "src/a.ts", line: 3, side: "RIGHT" })
    ).toBe(4);
    expect(
      findDiffPosition(lines, { path: "src/a.ts", line: 12, side: "RIGHT" })
    ).toBe(7);
  });

  test("keeps unmappable findings in review body", () => {
    const pr: PullRequest = {
      number: 1,
      url: "",
      title: "",
      state: "OPEN",
      headRefName: "h",
      baseRefName: "b",
      headRefOid: "sha",
    };
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
    expect(review.comments).toHaveLength(0);
    expect(review.summaryCount).toBe(1);
  });
});
