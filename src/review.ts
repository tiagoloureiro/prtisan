import { findDiffPosition, parseUnifiedDiff } from "./diff.js";
import { reviewFindingBody } from "./github.js";
import type { PullRequest, ReviewFinding } from "./types.js";

export interface PreparedReview {
  readonly event: "COMMENT" | "REQUEST_CHANGES";
  readonly body: string;
  readonly comments: readonly {
    readonly path: string;
    readonly position: number;
    readonly body: string;
  }[];
  readonly inlineCount: number;
  readonly summaryCount: number;
}

export function preparePullRequestReview(input: {
  readonly pr: PullRequest;
  readonly diff: string;
  readonly findings: readonly ReviewFinding[];
}): PreparedReview {
  const diffLines = parseUnifiedDiff(input.diff);
  const comments: {
    path: string;
    position: number;
    body: string;
  }[] = [];
  const summaryFindings: ReviewFinding[] = [];

  for (const finding of input.findings) {
    if (finding.path && finding.line) {
      const position = findDiffPosition(diffLines, {
        path: finding.path,
        line: finding.line,
        side: finding.side,
      });
      if (position !== undefined) {
        comments.push({
          path: finding.path,
          position,
          body: reviewFindingBody(finding),
        });
        continue;
      }
    }

    summaryFindings.push(finding);
  }

  const event = input.findings.some(
    (finding) => finding.severity === "blocking"
  )
    ? "REQUEST_CHANGES"
    : "COMMENT";

  const body = buildReviewSummaryBody(input.findings, summaryFindings);

  return {
    event,
    body,
    comments,
    inlineCount: comments.length,
    summaryCount: summaryFindings.length,
  };
}

function buildReviewSummaryBody(
  findings: readonly ReviewFinding[],
  summaryFindings: readonly ReviewFinding[]
): string {
  if (findings.length === 0) {
    return "Agent train validation completed with no findings.";
  }

  if (summaryFindings.length === 0) {
    return "Agent train validation completed. All findings were attached inline.";
  }

  return [
    "Agent train validation completed. These findings could not be attached to an exact changed line:",
    "",
    ...summaryFindings.map(
      (finding) =>
        `- **${finding.severity} ${finding.axis}: ${finding.title}**${
          finding.path
            ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})`
            : ""
        }\n  ${finding.body}`
    ),
  ].join("\n");
}
