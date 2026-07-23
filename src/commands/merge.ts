import { runIdFromDate, syntheticBaseBranch } from "@/branching.js";
import { GitClient } from "@/git.js";
import { GitHubClient, isPullRequestGreen } from "@/github.js";
import {
  descendantsOfOpenPr,
  loadOpenPrGraph,
  type OpenPrGraph,
  type OpenPrNode,
} from "@/open-pr-graph.js";
import type { AgentTrainConfig, PullRequest } from "@/types.js";

export interface MergeInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly validateAffected?: boolean;
  readonly runId?: string;
}

export interface MergeDeps {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly validatePullRequests?: (
    pullNumbers: readonly number[]
  ) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface MergedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly headRefName: string;
  readonly headRefOid: string;
}

export interface MergeResult {
  readonly repo: string;
  readonly merged: readonly MergedPullRequest[];
}

export async function executeMerge(
  input: MergeInput,
  deps: MergeDeps
): Promise<MergeResult> {
  const runId = input.runId ?? runIdFromDate("merge");
  const merged: MergedPullRequest[] = [];
  let graph = await loadCurrentGraph(input, deps);

  while (graph.topologicalOrder.length > 0) {
    const prNumber = graph.topologicalOrder[0] as number;
    const node = graph.nodes.get(prNumber);
    if (!node) break;

    assertReadyToMerge(node);

    deps.log?.(`Squash-merging PR #${node.pr.number}`);
    await deps.github.mergePullRequest(
      input.config.repo,
      node.pr.number,
      node.pr.headRefOid,
      "squash"
    );
    const mergedPr = await deps.github.waitForPullRequestMerged(
      input.config.repo,
      node.pr.number
    );
    merged.push({
      number: mergedPr.number,
      url: mergedPr.url,
      headRefName: mergedPr.headRefName,
      headRefOid: mergedPr.headRefOid,
    });

    const affectedFromPreviousGraph = descendantsOfOpenPr(
      graph,
      node.pr.number
    );
    graph = await loadCurrentGraph(input, deps);
    const affected = affectedFromPreviousGraph.filter((affectedPr) =>
      graph.nodes.has(affectedPr)
    );

    if (affected.length > 0) {
      await restackDescendants(input, deps, graph, affected, runId);
      if (input.validateAffected ?? true) {
        await deps.validatePullRequests?.(affected);
      }
    }

    await deps.git.deleteRemoteBranch(node.pr.headRefName);
    await deps.git.deleteRemoteBranch(syntheticBaseBranch(node.pr.number));
    await cleanupObsoleteSyntheticBranches(input, deps);
    graph = await loadCurrentGraph(input, deps);
  }

  return {
    repo: input.config.repo,
    merged,
  };
}

async function loadCurrentGraph(
  input: MergeInput,
  deps: MergeDeps
): Promise<OpenPrGraph> {
  return loadOpenPrGraph({
    github: deps.github,
    repo: input.config.repo,
    targetBranch: input.config.targetBranch,
    concurrency: input.config.concurrency.github,
  });
}

function assertReadyToMerge(node: OpenPrNode): void {
  const validation = node.validation;
  if (validation.state === "missing") {
    throw new Error(
      `PR #${node.pr.number} has no agent-train validation review yet.`
    );
  }
  if (validation.state === "blocked") {
    throw new Error(
      `PR #${node.pr.number} has ${validation.blockingFindings} blocking agent validation finding(s).`
    );
  }

  const green = isPullRequestGreen(node.pr);
  if (!green.ok) {
    throw new Error(green.reason);
  }
}

async function restackDescendants(
  input: MergeInput,
  deps: MergeDeps,
  graph: OpenPrGraph,
  affected: readonly number[],
  runId: string
): Promise<void> {
  const affectedSet = new Set(affected);
  const ordered = graph.topologicalOrder
    .map((prNumber) => graph.nodes.get(prNumber))
    .filter((node): node is OpenPrNode =>
      Boolean(node && affectedSet.has(node.pr.number))
    );

  for (const node of ordered) {
    const openBlockerBranches = node.blockers
      .map((blocker) => graph.nodes.get(blocker)?.pr.headRefName)
      .filter((branch): branch is string => Boolean(branch));
    const nextBase = nextBaseBranch(input.config, node.pr, openBlockerBranches);

    if (openBlockerBranches.length > 1) {
      await deps.git.createSyntheticBaseBranch({
        runId,
        label: `base-pr-${node.pr.number}`,
        syntheticBranch: nextBase,
        blockerBranches: openBlockerBranches,
      });
    }

    const nextBaseAnchorSha = await deps.git.rebaseBranchOntoBase({
      runId,
      label: `restack-pr-${node.pr.number}`,
      branch: node.pr.headRefName,
      baseBranch: nextBase,
      oldBaseAnchorSha: node.pr.baseRefOid || undefined,
    });

    if (node.pr.baseRefName !== nextBase) {
      await deps.github.editPullRequestBase(
        input.config.repo,
        node.pr.number,
        nextBase
      );
      deps.log?.(
        `Retargeted PR #${node.pr.number} from ${node.pr.baseRefName} to ${nextBase} at ${nextBaseAnchorSha}`
      );
    }
  }
}

function nextBaseBranch(
  config: AgentTrainConfig,
  pr: PullRequest,
  openBlockerBranches: readonly string[]
): string {
  if (openBlockerBranches.length === 0) return config.targetBranch;
  if (openBlockerBranches.length === 1) return openBlockerBranches[0] as string;
  return syntheticBaseBranch(pr.number);
}

async function cleanupObsoleteSyntheticBranches(
  input: MergeInput,
  deps: MergeDeps
): Promise<void> {
  const graph = await loadCurrentGraph(input, deps);
  const liveBases = new Set(
    [...graph.nodes.values()].map((node) => node.pr.baseRefName)
  );
  for (const node of graph.nodes.values()) {
    const synthetic = syntheticBaseBranch(node.pr.number);
    if (!liveBases.has(synthetic)) {
      await deps.git.deleteRemoteBranch(synthetic);
    }
  }
}
