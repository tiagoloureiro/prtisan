import type { Issue, ReviewAxis, ReviewFinding } from "./types.js";

export interface ImplementPromptInput {
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly targetBranch: string;
  readonly baseBranch: string;
  readonly branch: string;
}

export interface ReviewPromptInput {
  readonly axis: ReviewAxis;
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly diff: string;
}

export interface RepairPromptInput {
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly findings: readonly ReviewFinding[];
  readonly branch: string;
}

export function buildImplementPrompt(input: ImplementPromptInput): string {
  return [
    `You are implementing GitHub issue #${input.issue.number} on branch ${input.branch}.`,
    `Base branch: ${input.baseBranch}. Target branch: ${input.targetBranch}.`,
    "",
    "Constraints:",
    "- Implement only this issue.",
    "- Preserve compatibility with the related blocker/dependent issues shown below.",
    "- Add or update focused tests where the change has behavior.",
    "- Run the smallest relevant verification command you can identify.",
    "- Commit your completed work to the current branch.",
    "- When finished, output <promise>COMPLETE</promise>.",
    "",
    issueBlock("Issue to implement", input.issue),
    relatedIssuesBlock(input.relatedIssues),
  ].join("\n");
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const axisInstructions =
    input.axis === "standards"
      ? [
          "Review only the Standards axis.",
          "Find documented-standard violations and meaningful code smells.",
          "Treat baseline smells as judgement calls, not hard violations.",
        ]
      : [
          "Review only the Spec axis.",
          "Find missing requirements, partial implementation, wrong behavior, and scope creep.",
          "Quote or reference the issue text that justifies each finding.",
        ];

  return [
    `You are validating PR #${input.prNumber} for GitHub issue #${input.issue.number}.`,
    `PR head branch: ${input.branch}.`,
    `Base branch: ${input.baseBranch}.`,
    "Use $code-review as the review rubric. Execute only the requested axis in this sandbox; agent-train runs the two axes in separate parallel sandboxes.",
    "",
    ...axisInstructions,
    "",
    "Return only JSON between <review> and </review> tags with this shape:",
    JSON.stringify(
      {
        axis: input.axis,
        summary: "one short summary",
        findings: [
          {
            axis: input.axis,
            severity: "blocking or advisory",
            title: "short title",
            body: "actionable explanation",
            path: "optional diff path",
            line: 123,
            side: "RIGHT",
          },
        ],
      },
      null,
      2,
    ),
    "After the </review> tag, output <promise>COMPLETE</promise>.",
    "",
    issueBlock("Primary issue", input.issue),
    relatedIssuesBlock(input.relatedIssues),
    "",
    "PR diff:",
    "```diff",
    input.diff,
    "```",
  ].join("\n");
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  return [
    `You are repairing branch ${input.branch} for GitHub issue #${input.issue.number}.`,
    "",
    "Fix only clear blocking validation findings listed below.",
    "Do not address advisory findings unless they are trivial and directly adjacent to a blocking fix.",
    "Run focused verification and commit the repair to the current branch.",
    "When finished, output <promise>COMPLETE</promise>.",
    "",
    issueBlock("Primary issue", input.issue),
    relatedIssuesBlock(input.relatedIssues),
    "",
    "Blocking findings:",
    JSON.stringify(input.findings.filter((finding) => finding.severity === "blocking"), null, 2),
  ].join("\n");
}

function relatedIssuesBlock(issues: readonly Issue[]): string {
  if (issues.length === 0) return "Related issues: none.";
  return ["Related issues:", ...issues.map((issue) => issueBlock(`Issue #${issue.number}`, issue))].join("\n\n");
}

function issueBlock(label: string, issue: Issue): string {
  return [
    `## ${label}`,
    `Number: #${issue.number}`,
    `Title: ${issue.title}`,
    `State: ${issue.state}`,
    `URL: ${issue.url}`,
    "",
    issue.body.trim() || "(No issue body.)",
  ].join("\n");
}
