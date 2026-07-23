import type { AgentRunner } from "@/agent.js";
import { runIdFromDate } from "@/branching.js";
import { GitClient } from "@/git.js";
import { GitHubClient } from "@/github.js";
import { preparePullRequestForMerge } from "@/merge-readiness.js";
import { loadOpenPrGraph, type OpenPrGraph } from "@/open-pr-graph.js";
import { restackAfterMerge } from "@/train-restacker.js";
import type { AgentTrainConfig } from "@/types.js";

export interface MergeInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly validateAffected?: boolean;
  readonly runId?: string;
}

export interface MergeDeps {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly agent?: AgentRunner;
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

  while (true) {
    if (graph.topologicalOrder.length === 0) break;

    const prNumber = graph.topologicalOrder[0] as number;
    const ready = await preparePullRequestForMerge(
      {
        cwd: input.cwd,
        config: input.config,
        graph,
        prNumber,
        runId,
      },
      deps
    );
    graph = ready.graph;
    const node = ready.node;

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

    const restacked = await restackAfterMerge(
      {
        cwd: input.cwd,
        config: input.config,
        previousGraph: graph,
        mergedPrNumber: node.pr.number,
        runId,
      },
      deps
    );
    if (restacked.affected.length > 0) {
      if (input.validateAffected ?? true) {
        await deps.validatePullRequests?.(restacked.affected);
      }
    }

    await deps.git.deleteRemoteBranch(node.pr.headRefName);
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
