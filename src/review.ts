import { reviewFindingBody } from "./github.js";
import type { PullRequest, ReviewFinding, ValidationOutcome } from "./types.js";

interface DiffLine {
  readonly path: string;
  readonly position: number;
  readonly side: "RIGHT" | "LEFT";
  readonly line: number;
}

interface ReviewLocation {
  readonly path: string;
  readonly line: number;
  readonly side?: "RIGHT" | "LEFT";
}

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

export interface ValidationReviewMetadata {
  readonly schemaVersion: 2;
  readonly baseRefOid: string;
  readonly snapshotKey: string;
  readonly policyDigest: string;
  readonly issueContextDigest: string;
  readonly runtimeFingerprint: string;
  readonly outcome: ValidationOutcome["kind"];
  readonly findingIds: readonly string[];
}

export const VALIDATION_REVIEW_MARKER = "agent-train:validation";

export function preparePullRequestReview(input: {
  readonly pr: PullRequest;
  readonly diff: string;
  readonly findings: readonly ReviewFinding[];
  readonly specSkipped?: boolean;
  readonly metadata?: ValidationReviewMetadata;
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

  const body = [
    validationMarker({
      headRefOid: input.pr.headRefOid,
      blockingFindings: input.findings.filter(
        (finding) => finding.severity === "blocking"
      ).length,
      advisoryFindings: input.findings.filter(
        (finding) => finding.severity === "advisory"
      ).length,
      specSkipped: Boolean(input.specSkipped),
      schemaVersion: input.metadata?.schemaVersion ?? 2,
      baseRefOid: input.metadata?.baseRefOid ?? input.pr.baseRefOid,
      snapshotKey: input.metadata?.snapshotKey,
      policyDigest: input.metadata?.policyDigest,
      issueContextDigest: input.metadata?.issueContextDigest,
      runtimeFingerprint: input.metadata?.runtimeFingerprint,
      outcome:
        input.metadata?.outcome ??
        (input.findings.some((finding) => finding.severity === "blocking")
          ? "blocked"
          : "passed"),
      findingIds:
        input.metadata?.findingIds ??
        input.findings
          .map((finding) => finding.findingId)
          .filter((id): id is string => Boolean(id)),
    }),
    buildReviewSummaryBody(input.findings, summaryFindings),
  ].join("\n");

  return {
    event,
    body,
    comments,
    inlineCount: comments.length,
    summaryCount: summaryFindings.length,
  };
}

function validationMarker(input: {
  readonly headRefOid: string;
  readonly blockingFindings: number;
  readonly advisoryFindings: number;
  readonly specSkipped: boolean;
  readonly schemaVersion: number;
  readonly baseRefOid: string;
  readonly snapshotKey?: string;
  readonly policyDigest?: string;
  readonly issueContextDigest?: string;
  readonly runtimeFingerprint?: string;
  readonly outcome: ValidationOutcome["kind"];
  readonly findingIds: readonly string[];
}): string {
  return `<!-- ${VALIDATION_REVIEW_MARKER} ${JSON.stringify(input)} -->`;
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

function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.split("\n");
  const entries: DiffLine[] = [];
  let currentPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let position = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentPath = undefined;
      inHunk = false;
      oldLine = 0;
      newLine = 0;
      position = 0;
      continue;
    }

    if (line.startsWith("+++ ")) {
      currentPath = parseDiffPath(line.slice(4));
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      inHunk = true;
      continue;
    }

    if (!currentPath || !inHunk || line.length === 0) {
      continue;
    }

    const prefix = line[0];
    if (prefix === "+") {
      position += 1;
      entries.push({
        path: currentPath,
        position,
        side: "RIGHT",
        line: newLine,
      });
      newLine += 1;
    } else if (prefix === "-") {
      position += 1;
      entries.push({
        path: currentPath,
        position,
        side: "LEFT",
        line: oldLine,
      });
      oldLine += 1;
    } else if (prefix === " ") {
      position += 1;
      entries.push({
        path: currentPath,
        position,
        side: "RIGHT",
        line: newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return entries;
}

function findDiffPosition(
  diffLines: readonly DiffLine[],
  location: ReviewLocation
): number | undefined {
  const side = location.side ?? "RIGHT";
  return diffLines.find(
    (line) =>
      line.path === location.path &&
      line.line === location.line &&
      line.side === side
  )?.position;
}

function parseDiffPath(raw: string): string | undefined {
  if (raw === "/dev/null") return undefined;
  return raw.replace(/^"|"$/g, "").replace(/^b\//, "").replace(/^a\//, "");
}
