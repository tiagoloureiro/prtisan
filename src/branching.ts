import { slugify } from "./path.js";
import type { AgentTrainConfig, Issue } from "./types.js";

export function issueBranch(
  config: AgentTrainConfig,
  issue: Pick<Issue, "number" | "title">
): string {
  return `${config.branchPrefix}${issue.number}-${slugify(issue.title)}`;
}

export function syntheticBaseBranch(
  config: AgentTrainConfig,
  trainId: string,
  issueNumber: number
): string {
  return `${config.trainPrefix}/${trainId}/base/${issueNumber}`;
}

export function reviewSandboxBranch(
  config: AgentTrainConfig,
  trainId: string,
  prNumber: number,
  axis: "standards" | "spec"
): string {
  return `${config.trainPrefix}/${trainId}/review/${prNumber}-${axis}-${crypto.randomUUID().slice(0, 8)}`;
}

export function trainIdFromDate(date = new Date()): string {
  const stamp = date.toISOString().replaceAll("-", "").replace(/T.*/, "");
  const random = crypto.randomUUID().slice(0, 8);
  return `${stamp}-${random}`;
}
