import { describe, expect, test } from "bun:test";

import { parseReviewReport } from "@/agent.js";

describe("agent review parsing", () => {
  test("parses fenced JSON inside review tags", () => {
    const report = parseReviewReport(
      [
        "<review>",
        "```json",
        JSON.stringify({
          summary: "Needs work.",
          findings: [
            {
              severity: "blocking",
              title: "Missing check",
              body: "Add the guard.",
            },
          ],
        }),
        "```",
        "</review>",
        "<promise>COMPLETE</promise>",
      ].join("\n"),
      "spec"
    );

    expect(report.axis).toBe("spec");
    expect(report.findings[0]).toMatchObject({
      axis: "spec",
      severity: "blocking",
      title: "Missing check",
    });
  });
});
