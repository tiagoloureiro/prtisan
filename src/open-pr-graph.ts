import { mapLimit } from "./concurrency.js";
import type { GitHubClient } from "./github.js";
import { VALIDATION_REVIEW_MARKER } from "./review.js";
import type { Issue, PullRequest } from "./types.js";

export type PrValidationState = "missing" | "passed" | "commented" | "blocked";

export interface PrValidationStatus {
  readonly state: PrValidationState;
  readonly checkedAt?: string;
  readonly blockingFindings: number;
  readonly advisoryFindings: number;
  readonly reviewEvent?: "COMMENT" | "REQUEST_CHANGES";
  readonly specSkipped?: boolean;
}

export interface OpenPrNode {
  readonly pr: PullRequest;
  readonly issue?: Issue;
  readonly relatedIssues: readonly Issue[];
  readonly blockers: readonly number[];
  readonly blocking: readonly number[];
  readonly validation: PrValidationStatus;
}

export interface OpenPrGraph {
  readonly nodes: ReadonlyMap<number, OpenPrNode>;
  readonly layers: readonly (readonly number[])[];
  readonly topologicalOrder: readonly number[];
}

export interface OpenPrInput {
  readonly pr: PullRequest;
  readonly issue?: Issue;
  readonly relatedIssues?: readonly Issue[];
}

export class OpenPrGraphCycleError extends Error {
  readonly cycle: readonly number[];

  constructor(cycle: readonly number[]) {
    super(
      `Open PR graph contains a cycle: ${cycle.map((n) => `#${n}`).join(" -> ")}`
    );
    this.name = "OpenPrGraphCycleError";
    this.cycle = cycle;
  }
}

export async function loadOpenPrGraph(input: {
  readonly github: GitHubClient;
  readonly repo: string;
  readonly targetBranch: string;
  readonly concurrency?: number;
}): Promise<OpenPrGraph> {
  const prs = await input.github.listOpenPullRequests(input.repo);
  const issues = new Map<number, Promise<Issue>>();
  const getIssue = (issueNumber: number): Promise<Issue> => {
    const cached = issues.get(issueNumber);
    if (cached) return cached;
    const promise = input.github.getIssue(input.repo, issueNumber);
    issues.set(issueNumber, promise);
    return promise;
  };
  const enriched = await mapLimit(
    prs,
    input.concurrency ?? 4,
    async (pr): Promise<OpenPrInput> => {
      const issueNumber = primaryClosingIssueNumber(pr);
      if (!issueNumber) return { pr, relatedIssues: [] };

      const issue = await getIssue(issueNumber);
      const relatedIssues = await loadRelatedIssues(issue, getIssue);
      return { pr, issue, relatedIssues };
    }
  );

  return buildOpenPrGraph(enriched, input.targetBranch);
}

async function loadRelatedIssues(
  issue: Issue,
  getIssue: (issueNumber: number) => Promise<Issue>
): Promise<Issue[]> {
  const numbers = new Set<number>();
  for (const ref of [
    ...issue.blockedBy,
    ...issue.blocking,
    ...issue.subIssues,
  ]) {
    numbers.add(ref.number);
  }
  if (issue.parent) numbers.add(issue.parent.number);
  numbers.delete(issue.number);
  return Promise.all([...numbers].map((issueNumber) => getIssue(issueNumber)));
}

export function buildOpenPrGraph(
  inputs: readonly OpenPrInput[],
  targetBranch: string
): OpenPrGraph {
  const headBranchToPr = new Map<string, number>();
  const issueToPr = new Map<number, number>();
  const inputByPr = new Map<number, OpenPrInput>();

  for (const input of inputs) {
    headBranchToPr.set(input.pr.headRefName, input.pr.number);
    inputByPr.set(input.pr.number, input);
    for (const ref of input.pr.closingIssuesReferences) {
      issueToPr.set(ref.number, input.pr.number);
    }
    if (input.issue) {
      issueToPr.set(input.issue.number, input.pr.number);
    }
  }

  const blockersByPr = new Map<number, Set<number>>();
  const blockingByPr = new Map<number, Set<number>>();
  for (const input of inputs) {
    blockersByPr.set(input.pr.number, new Set());
    blockingByPr.set(input.pr.number, new Set());
  }

  for (const input of inputs) {
    const blockerFromBase = headBranchToPr.get(input.pr.baseRefName);
    if (
      blockerFromBase &&
      blockerFromBase !== input.pr.number &&
      input.pr.baseRefName !== targetBranch
    ) {
      blockersByPr.get(input.pr.number)?.add(blockerFromBase);
    }

    if (!input.issue) continue;
    for (const blocker of input.issue.blockedBy) {
      const blockerPr = issueToPr.get(blocker.number);
      if (blockerPr && blockerPr !== input.pr.number) {
        blockersByPr.get(input.pr.number)?.add(blockerPr);
      }
    }
    for (const blocked of input.issue.blocking) {
      const blockedPr = issueToPr.get(blocked.number);
      if (blockedPr && blockedPr !== input.pr.number) {
        blockersByPr.get(blockedPr)?.add(input.pr.number);
      }
    }
  }

  for (const [prNumber, blockers] of blockersByPr.entries()) {
    for (const blocker of blockers) {
      blockingByPr.get(blocker)?.add(prNumber);
    }
  }

  const cycle = findCycle(blockersByPr);
  if (cycle) {
    throw new OpenPrGraphCycleError(cycle);
  }

  const layers = topologicalLayers(blockersByPr);
  const nodes = new Map<number, OpenPrNode>();
  for (const prNumber of layers.flat()) {
    const input = inputByPr.get(prNumber);
    if (!input) continue;
    nodes.set(prNumber, {
      pr: input.pr,
      issue: input.issue,
      relatedIssues: input.relatedIssues ?? [],
      blockers: sortedNumbers(blockersByPr.get(prNumber) ?? new Set()),
      blocking: sortedNumbers(blockingByPr.get(prNumber) ?? new Set()),
      validation: validationStatusFromPr(input.pr),
    });
  }

  return {
    nodes,
    layers,
    topologicalOrder: layers.flat(),
  };
}

export function descendantsOfOpenPr(
  graph: OpenPrGraph,
  prNumber: number
): number[] {
  const descendants = new Set<number>();
  const queue = [...(graph.nodes.get(prNumber)?.blocking ?? [])];

  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (descendants.has(current)) continue;
    descendants.add(current);
    queue.push(...(graph.nodes.get(current)?.blocking ?? []));
  }

  return [...descendants].sort(
    (a, b) =>
      graph.topologicalOrder.indexOf(a) - graph.topologicalOrder.indexOf(b)
  );
}

export function primaryClosingIssueNumber(
  pr: Pick<PullRequest, "closingIssuesReferences">
): number | undefined {
  return pr.closingIssuesReferences[0]?.number;
}

export function validationStatusFromPr(
  pr: Pick<PullRequest, "latestReviews">
): PrValidationStatus {
  const review = [...pr.latestReviews]
    .reverse()
    .find((item) => item.body.includes(VALIDATION_REVIEW_MARKER));
  if (!review) {
    return {
      state: "missing",
      blockingFindings: 0,
      advisoryFindings: 0,
    };
  }

  const meta = parseValidationMarker(review.body);
  const blockingFindings = meta.blockingFindings ?? 0;
  const advisoryFindings = meta.advisoryFindings ?? 0;
  const blocked =
    blockingFindings > 0 || review.state.toUpperCase() === "CHANGES_REQUESTED";

  return {
    state: blocked ? "blocked" : advisoryFindings > 0 ? "commented" : "passed",
    checkedAt: review.submittedAt,
    blockingFindings,
    advisoryFindings,
    reviewEvent: blocked ? "REQUEST_CHANGES" : "COMMENT",
    specSkipped: meta.specSkipped,
  };
}

function parseValidationMarker(body: string): Partial<PrValidationStatus> {
  const match = body.match(
    new RegExp(`<!--\\s*${VALIDATION_REVIEW_MARKER}\\s+({[^]*?})\\s*-->`)
  );
  if (!match?.[1]) return {};

  try {
    const parsed = JSON.parse(match[1]) as {
      blockingFindings?: unknown;
      advisoryFindings?: unknown;
      specSkipped?: unknown;
    };
    return {
      blockingFindings:
        typeof parsed.blockingFindings === "number"
          ? parsed.blockingFindings
          : undefined,
      advisoryFindings:
        typeof parsed.advisoryFindings === "number"
          ? parsed.advisoryFindings
          : undefined,
      specSkipped:
        typeof parsed.specSkipped === "boolean"
          ? parsed.specSkipped
          : undefined,
    };
  } catch {
    return {};
  }
}

function topologicalLayers(blockersByPr: ReadonlyMap<number, Set<number>>) {
  const remaining = new Set(blockersByPr.keys());
  const layers: number[][] = [];

  while (remaining.size > 0) {
    const layer = [...remaining]
      .filter((prNumber) =>
        [...(blockersByPr.get(prNumber) ?? [])].every(
          (blocker) => !remaining.has(blocker)
        )
      )
      .sort((a, b) => a - b);

    if (layer.length === 0) {
      throw new OpenPrGraphCycleError([...remaining]);
    }

    layers.push(layer);
    for (const prNumber of layer) {
      remaining.delete(prNumber);
    }
  }

  return layers;
}

function findCycle(
  blockersByPr: ReadonlyMap<number, Set<number>>
): number[] | undefined {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const stack: number[] = [];

  function visit(prNumber: number): number[] | undefined {
    if (visited.has(prNumber)) return undefined;
    if (visiting.has(prNumber)) {
      const cycleStart = stack.indexOf(prNumber);
      return [...stack.slice(cycleStart), prNumber];
    }

    visiting.add(prNumber);
    stack.push(prNumber);

    for (const blocker of blockersByPr.get(prNumber) ?? []) {
      const cycle = visit(blocker);
      if (cycle) return cycle;
    }

    stack.pop();
    visiting.delete(prNumber);
    visited.add(prNumber);
    return undefined;
  }

  for (const prNumber of blockersByPr.keys()) {
    const cycle = visit(prNumber);
    if (cycle) return cycle;
  }

  return undefined;
}

function sortedNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
