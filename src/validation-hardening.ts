import { createHash } from "node:crypto";

import type {
  AgentTrainConfig,
  Issue,
  PullRequest,
  ReviewFinding,
} from "./types.js";

export const VALIDATION_POLICY_VERSION = 2;

export interface ValidationSnapshot {
  readonly key: string;
  readonly headRefOid: string;
  readonly baseRefOid: string;
  readonly diffDigest: string;
  readonly issueContextDigest: string;
  readonly standardsDigest: string;
  readonly runtimeFingerprint: string;
  readonly policyDigest: string;
  readonly changedFiles: readonly string[];
}

export function buildValidationSnapshot(input: {
  readonly pr: PullRequest;
  readonly diff: string;
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly standardsContents?: readonly string[];
  readonly runtimeFingerprint: string;
  readonly config: AgentTrainConfig;
}): ValidationSnapshot {
  const changedFiles = changedFilesFromDiff(input.diff);
  const issueContextDigest = validationIssueContextDigest(
    input.issue,
    input.relatedIssues
  );
  const policyDigest = stableDigest({
    version: VALIDATION_POLICY_VERSION,
    agentProfiles: input.config.agentProfiles,
    validation: input.config.validation,
  });
  const snapshot = {
    headRefOid: input.pr.headRefOid,
    baseRefOid: input.pr.baseRefOid,
    diffDigest: stableDigest(input.diff),
    issueContextDigest,
    standardsDigest: stableDigest(input.standardsContents ?? []),
    runtimeFingerprint: input.runtimeFingerprint,
    policyDigest,
    changedFiles,
  };

  return {
    ...snapshot,
    key: stableDigest(snapshot),
  };
}

export function validationIssueContextDigest(
  issue: Issue | undefined,
  relatedIssues: readonly Issue[]
): string {
  return stableDigest({
    primary: issue ? issueDigestValue(issue, true) : undefined,
    related: relatedIssues.map((related) => issueDigestValue(related, false)),
  });
}

export function normalizeAndDedupeFindings(
  findings: readonly ReviewFinding[]
): ReviewFinding[] {
  const normalized = findings.map((finding) => {
    const rule = cleanText(finding.rule) || defaultRule(finding);
    const evidence = cleanText(finding.evidence) || cleanText(finding.body);
    const normalizedFinding = {
      ...finding,
      title: cleanText(finding.title) || "Review finding",
      body: cleanText(finding.body),
      rule,
      evidence,
    };
    return {
      ...normalizedFinding,
      findingId: findingFingerprint(normalizedFinding),
    };
  });
  const byId = new Map<string, ReviewFinding>();

  for (const finding of normalized) {
    const id = finding.findingId as string;
    const existing = byId.get(id);
    if (!existing || severityRank(finding) > severityRank(existing)) {
      byId.set(id, finding);
    }
  }

  return [...byId.values()].sort((left, right) => {
    const severity = severityRank(right) - severityRank(left);
    if (severity !== 0) return severity;
    return (left.findingId ?? "").localeCompare(right.findingId ?? "");
  });
}

export function findingFingerprint(
  finding: Pick<ReviewFinding, "axis" | "title" | "path" | "rule">
): string {
  return stableDigest({
    axis: finding.axis,
    rule: normalizeFingerprintText(finding.rule ?? ""),
    path: normalizePath(finding.path ?? ""),
    title: normalizeFingerprintText(finding.title),
  }).slice(0, 24);
}

export function stableDigest(value: unknown): string {
  const normalized =
    typeof value === "string" ? value : stableJsonStringify(value);
  return createHash("sha256").update(normalized).digest("hex");
}

export function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match?.[2]) files.add(match[2]);
  }
  return [...files].sort();
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function issueDigestValue(issue: Issue, includeBody: boolean): unknown {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: includeBody ? issue.body : undefined,
    blockedBy: issue.blockedBy.map((ref) => [ref.number, ref.state]),
    blocking: issue.blocking.map((ref) => [ref.number, ref.state]),
    parent: issue.parent
      ? [issue.parent.number, issue.parent.state]
      : undefined,
    subIssues: issue.subIssues.map((ref) => [ref.number, ref.state]),
  };
}

function defaultRule(finding: ReviewFinding): string {
  return finding.axis === "spec"
    ? "Linked issue requirement"
    : "Repository standards";
}

function cleanText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeFingerprintText(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function severityRank(finding: ReviewFinding): number {
  return finding.severity === "blocking" ? 2 : 1;
}
