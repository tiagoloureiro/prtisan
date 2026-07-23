import type {
  AgentTrainConfig,
  IssueTrainRecord,
  SyntheticBaseRecord,
  TrainState,
} from "./types.js";
import type { BranchPlan, IssueGraph } from "./graph.js";
import { readJson, writeJson } from "./fs.js";
import { joinPath } from "./path.js";

export function trainStatePath(cwd: string, trainId: string): string {
  return joinPath(cwd, ".sandcastle", "trains", trainId, "state.json");
}

export function createTrainState(
  trainId: string,
  config: AgentTrainConfig,
  graph: IssueGraph,
  branchPlan: BranchPlan,
  now = new Date(),
): TrainState {
  const timestamp = now.toISOString();
  const issues: Record<string, IssueTrainRecord> = {};
  const syntheticBases: Record<string, SyntheticBaseRecord> = {};

  for (const issueNumber of graph.topologicalOrder) {
    const node = graph.nodes.get(issueNumber);
    const planned = branchPlan.issues.get(issueNumber);
    if (!node || !planned) continue;

    issues[String(issueNumber)] = {
      issue: node.issue,
      branch: planned.issueBranch,
      baseBranch: planned.baseBranch,
      blockers: planned.blockers,
      syntheticBase: planned.syntheticBase,
      status: "planned",
      commits: [],
    };

    if (planned.syntheticBase) {
      syntheticBases[String(issueNumber)] = {
        issueNumber,
        branch: planned.syntheticBase,
        blockers: planned.blockers,
        status: "planned",
      };
    }
  }

  return {
    trainId,
    repo: config.repo,
    targetBranch: config.targetBranch,
    createdAt: timestamp,
    updatedAt: timestamp,
    issues,
    syntheticBases,
  };
}

export function reconcileTrainState(
  existing: TrainState,
  config: AgentTrainConfig,
  graph: IssueGraph,
  branchPlan: BranchPlan,
  now = new Date(),
): TrainState {
  const fresh = createTrainState(existing.trainId, config, graph, branchPlan, now);
  const issues: Record<string, IssueTrainRecord> = {};

  for (const [issueNumber, freshRecord] of Object.entries(fresh.issues)) {
    const oldRecord = existing.issues[issueNumber];
    if (!oldRecord) {
      issues[issueNumber] = freshRecord;
      continue;
    }

    issues[issueNumber] = {
      ...freshRecord,
      branch: oldRecord.pr ? oldRecord.branch : freshRecord.branch,
      baseBranch: oldRecord.pr ? oldRecord.baseBranch : freshRecord.baseBranch,
      blockers: oldRecord.pr ? oldRecord.blockers : freshRecord.blockers,
      syntheticBase: oldRecord.pr ? oldRecord.syntheticBase : freshRecord.syntheticBase,
      status: oldRecord.status,
      pr: oldRecord.pr,
      commits: oldRecord.commits,
      lastError: oldRecord.lastError,
      validation: oldRecord.validation,
      baseAnchorSha: oldRecord.baseAnchorSha,
    };
  }

  const syntheticBases: Record<string, SyntheticBaseRecord> = {};
  for (const [issueNumber, freshSynthetic] of Object.entries(fresh.syntheticBases)) {
    const oldSynthetic = existing.syntheticBases[issueNumber];
    syntheticBases[issueNumber] = oldSynthetic
      ? {
          ...freshSynthetic,
          status: oldSynthetic.status,
          lastError: oldSynthetic.lastError,
        }
      : freshSynthetic;
  }

  return {
    ...fresh,
    createdAt: existing.createdAt,
    updatedAt: now.toISOString(),
    issues,
    syntheticBases,
  };
}

export async function loadTrainState(cwd: string, trainId: string): Promise<TrainState> {
  return readJson<TrainState>(trainStatePath(cwd, trainId));
}

export async function saveTrainState(cwd: string, state: TrainState): Promise<void> {
  await writeJson(trainStatePath(cwd, state.trainId), {
    ...state,
    updatedAt: new Date().toISOString(),
  });
}

export function updateIssueRecord(
  state: TrainState,
  issueNumber: number,
  update: Partial<IssueTrainRecord>,
): TrainState {
  const key = String(issueNumber);
  const current = state.issues[key];
  if (!current) {
    throw new Error(`Issue #${issueNumber} is not part of train ${state.trainId}.`);
  }

  return {
    ...state,
    updatedAt: new Date().toISOString(),
    issues: {
      ...state.issues,
      [key]: {
        ...current,
        ...update,
      },
    },
  };
}

export function updateSyntheticBase(
  state: TrainState,
  issueNumber: number,
  update: Partial<SyntheticBaseRecord>,
): TrainState {
  const key = String(issueNumber);
  const current = state.syntheticBases[key];
  if (!current) return state;

  return {
    ...state,
    updatedAt: new Date().toISOString(),
    syntheticBases: {
      ...state.syntheticBases,
      [key]: {
        ...current,
        ...update,
      },
    },
  };
}

export function trainMetadata(record: IssueTrainRecord, trainId: string): string {
  return [
    "<!-- agent-train",
    JSON.stringify({
      trainId,
      issue: record.issue.number,
      branch: record.branch,
      baseBranch: record.baseBranch,
      baseAnchorSha: record.baseAnchorSha,
      blockers: record.blockers,
      syntheticBase: record.syntheticBase,
    }),
    "agent-train -->",
  ].join("\n");
}

export function mergeMetadataIntoPrBody(body: string, metadata: string): string {
  const stripped = body.replace(/<!-- agent-train[\s\S]*?agent-train -->\n?/g, "").trimEnd();
  return `${stripped}\n\n${metadata}\n`;
}
