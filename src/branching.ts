import type { ReviewAxis } from "./types.js";

export function syntheticBaseBranch(prNumber: number): string {
  return `agent-train/base/pr-${prNumber}`;
}

export function reviewSandboxBranch(
  prNumber: number,
  axis: ReviewAxis
): string {
  return `agent-train/review/pr-${prNumber}-${axis}-${crypto.randomUUID().slice(0, 8)}`;
}

export function issueReviewSandboxBranch(issueNumber: number): string {
  return `agent-train/review/issue-${issueNumber}-spec-${crypto.randomUUID().slice(0, 8)}`;
}

export function issueRepairBranch(issueNumber: number): string {
  return `agent-train/repair/issue-${issueNumber}`;
}

export function runIdFromDate(label: string, date = new Date()): string {
  const stamp = date.toISOString().replaceAll("-", "").replace(/T.*/, "");
  const random = crypto.randomUUID().slice(0, 8);
  return `${label}-${stamp}-${random}`;
}
