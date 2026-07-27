import type { ReviewAxis } from "./types.js";

export function reviewSandboxBranch(
  prNumber: number,
  axis: ReviewAxis
): string {
  return `prtisan/review/pr-${prNumber}-${axis}-${crypto.randomUUID().slice(0, 8)}`;
}

export function issueReviewSandboxBranch(issueNumber: number): string {
  return `prtisan/review/issue-${issueNumber}-spec-${crypto.randomUUID().slice(0, 8)}`;
}

export function runIdFromDate(label: string, date = new Date()): string {
  const stamp = date.toISOString().replaceAll("-", "").replace(/T.*/, "");
  const random = crypto.randomUUID().slice(0, 8);
  return `${label}-${stamp}-${random}`;
}
