import type { AgentTrainConfig, Issue } from "./types.js";
import { issueBranch, syntheticBaseBranch } from "./branching.js";

export interface IssueGraphNode {
  readonly issue: Issue;
  readonly blockers: readonly number[];
  readonly closedBlockers: readonly number[];
  readonly externalOpenBlockers: readonly number[];
  readonly blocking: readonly number[];
}

export interface IssueGraph {
  readonly nodes: ReadonlyMap<number, IssueGraphNode>;
  readonly layers: readonly (readonly number[])[];
  readonly topologicalOrder: readonly number[];
}

export interface PlannedIssueBranch {
  readonly issueNumber: number;
  readonly issueBranch: string;
  readonly baseBranch: string;
  readonly blockers: readonly number[];
  readonly syntheticBase?: string;
}

export interface BranchPlan {
  readonly issues: ReadonlyMap<number, PlannedIssueBranch>;
}

export class IssueGraphCycleError extends Error {
  readonly cycle: readonly number[];

  constructor(cycle: readonly number[]) {
    super(`Issue dependency graph contains a cycle: ${cycle.map((n) => `#${n}`).join(" -> ")}`);
    this.name = "IssueGraphCycleError";
    this.cycle = cycle;
  }
}

export function buildIssueGraph(issues: readonly Issue[]): IssueGraph {
  const openIssues = issues.filter((issue) => issue.state !== "CLOSED");
  const issueMap = new Map(openIssues.map((issue) => [issue.number, issue]));
  const allIssues = new Map(issues.map((issue) => [issue.number, issue]));
  const nodes = new Map<number, IssueGraphNode>();

  for (const issue of openIssues) {
    const internalBlockers: number[] = [];
    const closedBlockers: number[] = [];
    const externalOpenBlockers: number[] = [];

    for (const blocker of issue.blockedBy) {
      const known = allIssues.get(blocker.number);
      const state = known?.state ?? blocker.state;

      if (state === "CLOSED") {
        closedBlockers.push(blocker.number);
      } else if (issueMap.has(blocker.number)) {
        internalBlockers.push(blocker.number);
      } else {
        externalOpenBlockers.push(blocker.number);
      }
    }

    nodes.set(issue.number, {
      issue,
      blockers: uniqueSortedNumbers(internalBlockers),
      closedBlockers: uniqueSortedNumbers(closedBlockers),
      externalOpenBlockers: uniqueSortedNumbers(externalOpenBlockers),
      blocking: uniqueSortedNumbers(
        issue.blocking
          .map((blocked) => blocked.number)
          .filter((number) => issueMap.has(number)),
      ),
    });
  }

  for (const node of nodes.values()) {
    for (const blocker of node.blockers) {
      const blockerNode = nodes.get(blocker);
      if (!blockerNode) continue;
      nodes.set(blocker, {
        ...blockerNode,
        blocking: uniqueSortedNumbers([...blockerNode.blocking, node.issue.number]),
      });
    }
  }

  const cycle = findCycle(nodes);
  if (cycle) {
    throw new IssueGraphCycleError(cycle);
  }

  const layers = topologicalLayers(nodes);
  return {
    nodes,
    layers,
    topologicalOrder: layers.flat(),
  };
}

export function planBranches(
  graph: IssueGraph,
  config: AgentTrainConfig,
  trainId: string,
): BranchPlan {
  const issues = new Map<number, PlannedIssueBranch>();

  for (const issueNumber of graph.topologicalOrder) {
    const node = graph.nodes.get(issueNumber);
    if (!node) continue;

    const blockers = node.blockers;
    const syntheticBase =
      blockers.length > 1 ? syntheticBaseBranch(config, trainId, issueNumber) : undefined;
    const baseBranch =
      blockers.length === 0
        ? config.targetBranch
        : blockers.length === 1
          ? issueBranch(config, graph.nodes.get(blockers[0] as number)!.issue)
          : syntheticBase!;

    issues.set(issueNumber, {
      issueNumber,
      issueBranch: issueBranch(config, node.issue),
      baseBranch,
      blockers,
      syntheticBase,
    });
  }

  return { issues };
}

export function descendantsOf(graph: IssueGraph, issueNumber: number): number[] {
  const descendants = new Set<number>();
  const queue = [...(graph.nodes.get(issueNumber)?.blocking ?? [])];

  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (descendants.has(current)) continue;
    descendants.add(current);
    queue.push(...(graph.nodes.get(current)?.blocking ?? []));
  }

  return [...descendants].sort((a, b) => graph.topologicalOrder.indexOf(a) - graph.topologicalOrder.indexOf(b));
}

function topologicalLayers(nodes: ReadonlyMap<number, IssueGraphNode>): number[][] {
  const remaining = new Set(nodes.keys());
  const layers: number[][] = [];

  while (remaining.size > 0) {
    const layer = [...remaining]
      .filter((issueNumber) => {
        const node = nodes.get(issueNumber);
        return node ? node.blockers.every((blocker) => !remaining.has(blocker)) : false;
      })
      .sort((a, b) => a - b);

    if (layer.length === 0) {
      throw new IssueGraphCycleError([...remaining]);
    }

    layers.push(layer);
    for (const issueNumber of layer) {
      remaining.delete(issueNumber);
    }
  }

  return layers;
}

function findCycle(nodes: ReadonlyMap<number, IssueGraphNode>): number[] | undefined {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const stack: number[] = [];

  function visit(issueNumber: number): number[] | undefined {
    if (visited.has(issueNumber)) return undefined;
    if (visiting.has(issueNumber)) {
      const cycleStart = stack.indexOf(issueNumber);
      return [...stack.slice(cycleStart), issueNumber];
    }

    visiting.add(issueNumber);
    stack.push(issueNumber);

    for (const blocker of nodes.get(issueNumber)?.blockers ?? []) {
      const cycle = visit(blocker);
      if (cycle) return cycle;
    }

    stack.pop();
    visiting.delete(issueNumber);
    visited.add(issueNumber);
    return undefined;
  }

  for (const issueNumber of nodes.keys()) {
    const cycle = visit(issueNumber);
    if (cycle) return cycle;
  }

  return undefined;
}

function uniqueSortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
