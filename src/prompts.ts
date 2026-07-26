import type {
  Issue,
  PullRequestCheckEvidence,
  ReviewAxis,
  ReviewFinding,
} from "./types.js";

export interface ReviewPromptInput {
  readonly axis: ReviewAxis;
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseRefOid?: string;
  readonly headRefOid?: string;
  readonly changedFiles?: readonly string[];
  /** @deprecated The raw diff is deliberately excluded from prompts. */
  readonly diff?: string;
}

export interface RepairPromptInput {
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly findings: readonly ReviewFinding[];
  readonly prNumber: number;
  readonly branch: string;
}

export interface CiRepairPromptInput {
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly checkEvidence: readonly PullRequestCheckEvidence[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
}

export interface MergeStateRepairPromptInput {
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly blockers: readonly string[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly mergeState: string;
}

export interface IssueBranchReviewPromptInput {
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly targetBranch: string;
}

export interface IssueBranchRepairPromptInput {
  readonly issue: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly findings: readonly ReviewFinding[];
  readonly branch: string;
  readonly targetBranch: string;
}

export interface RepairVerificationPromptInput {
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly findings: readonly ReviewFinding[];
  readonly prNumber: number;
  readonly branch: string;
  readonly baseRefOid: string;
  readonly repairedHeadRefOid: string;
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
    input.issue
      ? `You are validating PR #${input.prNumber} for GitHub issue #${input.issue.number}.`
      : `You are validating PR #${input.prNumber}. It has no linked closing issue.`,
    `PR head branch: ${input.branch}.`,
    `Base branch: ${input.baseBranch}.`,
    `Pinned base: ${input.baseRefOid ?? input.baseBranch}.`,
    `Pinned head: ${input.headRefOid ?? "HEAD"}.`,
    `Inspect the change with: git diff ${input.baseRefOid ?? input.baseBranch}...${input.headRefOid ?? "HEAD"}.`,
    "Use $code-review as the review rubric. Execute only the requested axis in this sandbox; prtisan runs the two axes in separate parallel sandboxes.",
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
            rule: "documented rule or issue requirement",
            evidence: "specific observed code or behavior",
            path: "optional diff path",
            line: 123,
            side: "RIGHT",
          },
        ],
      },
      null,
      2
    ),
    "After the </review> tag, output <promise>COMPLETE</promise>.",
    "",
    input.issue
      ? issueBlock("Primary issue", input.issue)
      : "Primary issue: none linked. For this PR, run Standards only; Spec is skipped by agent-train.",
    relatedIssuesSummary(input.relatedIssues),
    "",
    `Changed files: ${(input.changedFiles ?? []).join(", ") || "(inspect the diff)"}.`,
  ].join("\n");
}

export function buildIssueBranchReviewPrompt(
  input: IssueBranchReviewPromptInput
): string {
  return [
    `You are validating target branch ${input.targetBranch} for GitHub issue #${input.issue.number}.`,
    "There is no PR diff for this validation. Inspect the repository state on the current branch and decide whether it satisfies the issue.",
    "Use $code-review as the review rubric, but run only the Spec axis.",
    "",
    "Review only the Spec axis.",
    "Find missing requirements, partial implementation, wrong behavior, and scope creep.",
    "Quote or reference the issue text that justifies each finding.",
    "",
    "Return only JSON between <review> and </review> tags with this shape:",
    JSON.stringify(
      {
        axis: "spec",
        summary: "one short summary",
        findings: [
          {
            axis: "spec",
            severity: "blocking or advisory",
            title: "short title",
            body: "actionable explanation",
            rule: "issue requirement",
            evidence: "specific observed code or behavior",
            path: "optional repository path",
            line: 123,
          },
        ],
      },
      null,
      2
    ),
    "After the </review> tag, output <promise>COMPLETE</promise>.",
    "",
    issueBlock("Primary issue", input.issue),
    relatedIssuesSummary(input.relatedIssues),
  ].join("\n");
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  return [
    input.issue
      ? `You are repairing branch ${input.branch} for GitHub issue #${input.issue.number}.`
      : `You are repairing branch ${input.branch} for PR #${input.prNumber}. It has no linked closing issue.`,
    "",
    "Fix only clear blocking validation findings listed below.",
    "Do not address advisory findings unless they are trivial and directly adjacent to a blocking fix.",
    "Commit the repair to the current branch. Prtisan will independently run the authoritative verification commands.",
    "Return JSON between <repair> and </repair> with addressedFindingIds, changedPaths, summary, and limitations.",
    "When finished, output <promise>COMPLETE</promise>.",
    "",
    input.issue
      ? issueBlock("Primary issue", input.issue)
      : "Primary issue: none linked. Do not infer product requirements beyond the PR diff.",
    relatedIssuesSummary(input.relatedIssues),
    "",
    "Blocking findings:",
    JSON.stringify(
      input.findings.filter((finding) => finding.severity === "blocking"),
      null,
      2
    ),
  ].join("\n");
}

export function buildCiRepairPrompt(input: CiRepairPromptInput): string {
  return [
    `You are repairing branch ${input.branch} for PR #${input.prNumber} because GitHub checks failed.`,
    `Base branch: ${input.baseBranch}.`,
    "",
    "Use the failed check evidence below as the primary diagnosis input.",
    "Fix only clear causes of the failing checks.",
    "Do not make product scope changes unless they are required by the failing checks or the linked issue.",
    "Commit the repair to the current branch. Prtisan will independently run the authoritative verification commands.",
    "Return JSON between <repair> and </repair> with addressedFindingIds, changedPaths, summary, and limitations.",
    "When finished, output <promise>COMPLETE</promise>.",
    "",
    input.issue
      ? issueBlock("Primary issue", input.issue)
      : "Primary issue: none linked. Do not infer product requirements beyond the check failures.",
    relatedIssuesSummary(input.relatedIssues),
    "",
    "Failed check evidence:",
    JSON.stringify(input.checkEvidence, null, 2),
  ].join("\n");
}

export function buildMergeStateRepairPrompt(
  input: MergeStateRepairPromptInput
): string {
  return [
    `You are repairing branch ${input.branch} for PR #${input.prNumber} because GitHub reports merge state ${input.mergeState}.`,
    `Base branch: ${input.baseBranch}.`,
    "",
    "Fix only concrete mergeability blockers listed below.",
    "Do not attempt to satisfy required human review with code changes.",
    "Commit the repair to the current branch. Prtisan will independently run the authoritative verification commands.",
    "Return JSON between <repair> and </repair> with addressedFindingIds, changedPaths, summary, and limitations.",
    "When finished, output <promise>COMPLETE</promise>.",
    "",
    input.issue
      ? issueBlock("Primary issue", input.issue)
      : "Primary issue: none linked. Do not infer product requirements beyond the mergeability blockers.",
    relatedIssuesSummary(input.relatedIssues),
    "",
    "Mergeability blockers:",
    JSON.stringify(input.blockers, null, 2),
  ].join("\n");
}

export function buildIssueBranchRepairPrompt(
  input: IssueBranchRepairPromptInput
): string {
  return [
    `You are repairing branch ${input.branch} for GitHub issue #${input.issue.number}.`,
    `Base branch: ${input.targetBranch}.`,
    "",
    "Fix only clear blocking validation findings listed below.",
    "Do not address advisory findings unless they are trivial and directly adjacent to a blocking fix.",
    "Commit the repair to the current branch. Prtisan will independently run the authoritative verification commands.",
    "Return JSON between <repair> and </repair> with addressedFindingIds, changedPaths, summary, and limitations.",
    "When finished, output <promise>COMPLETE</promise>.",
    "",
    issueBlock("Primary issue", input.issue),
    relatedIssuesSummary(input.relatedIssues),
    "",
    "Blocking findings:",
    JSON.stringify(
      input.findings.filter((finding) => finding.severity === "blocking"),
      null,
      2
    ),
  ].join("\n");
}

export function buildRepairVerificationPrompt(
  input: RepairVerificationPromptInput
): string {
  return [
    `You are verifying the repair for PR #${input.prNumber} on branch ${input.branch}.`,
    `Original head: ${input.baseRefOid}.`,
    `Repaired head: ${input.repairedHeadRefOid}.`,
    `Inspect only the repair delta with: git diff ${input.baseRefOid}..${input.repairedHeadRefOid}.`,
    "",
    "Decide whether every original blocking finding is resolved and whether the repair delta introduced a new blocking Standards or Spec defect.",
    "Do not perform a new full review of the pre-existing PR diff.",
    "Return JSON between <repair-verification> and </repair-verification> with summary, resolvedFindingIds, and findings.",
    "Each new or surviving finding must include axis, severity, title, body, rule, evidence, and an optional diff location.",
    "After the closing tag, output <promise>COMPLETE</promise>.",
    "",
    input.issue
      ? issueBlock("Primary issue", input.issue)
      : "Primary issue: none linked.",
    relatedIssuesSummary(input.relatedIssues),
    "",
    "Original blocking findings:",
    JSON.stringify(input.findings, null, 2),
  ].join("\n");
}

function relatedIssuesSummary(issues: readonly Issue[]): string {
  if (issues.length === 0) return "Related issues: none.";
  return [
    "Related issue metadata:",
    ...issues.map((issue) =>
      [
        `- #${issue.number} ${issue.title} (${issue.state})`,
        `  blockedBy: ${issue.blockedBy.map((ref) => `#${ref.number}:${ref.state ?? "unknown"}`).join(", ") || "none"}`,
        `  blocking: ${issue.blocking.map((ref) => `#${ref.number}:${ref.state ?? "unknown"}`).join(", ") || "none"}`,
      ].join("\n")
    ),
  ].join("\n");
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
