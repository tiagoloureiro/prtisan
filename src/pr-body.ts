import { mergeMetadataIntoPrBody, trainMetadata } from "./state.js";
import type { IssueTrainRecord } from "./types.js";

export function buildPullRequestBody(
  record: IssueTrainRecord,
  trainId: string
): string {
  const blockers =
    record.blockers.length === 0
      ? "None"
      : record.blockers.map((blocker) => `#${blocker}`).join(", ");

  return mergeMetadataIntoPrBody(
    [
      `Closes #${record.issue.number}`,
      "",
      "## Agent Train",
      "",
      `- Train: \`${trainId}\``,
      `- Issue branch: \`${record.branch}\``,
      `- Base branch: \`${record.baseBranch}\``,
      record.baseAnchorSha ? `- Base anchor: \`${record.baseAnchorSha}\`` : "",
      `- Blocked by: ${blockers}`,
      record.syntheticBase
        ? `- Synthetic base: \`${record.syntheticBase}\``
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    trainMetadata(record, trainId)
  );
}
