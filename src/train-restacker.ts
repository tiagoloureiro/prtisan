import type { GitClient } from "./git.js";
import type { GitHubClient } from "./github.js";
import {
  descendantsOfOpenPr,
  loadOpenPrGraph,
  type OpenPrGraph,
  type OpenPrNode,
} from "./open-pr-graph.js";
import type { RuntimeProvider, VerificationRunner } from "./runtime.js";
import type { AgentTrainConfig, PullRequest } from "./types.js";

export interface TrainRestackInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly previousGraph: OpenPrGraph;
  readonly mergedPrNumber: number;
  readonly runId: string;
}

export interface TrainRestackDeps {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly runtime?: RuntimeProvider;
  readonly verification?: VerificationRunner;
  readonly log?: (message: string) => void;
}

export interface TrainRestackResult {
  readonly graph: OpenPrGraph;
  readonly affected: readonly number[];
}

export async function restackAfterMerge(
  input: TrainRestackInput,
  deps: TrainRestackDeps
): Promise<TrainRestackResult> {
  const affectedFromPreviousGraph = descendantsOfOpenPr(
    input.previousGraph,
    input.mergedPrNumber
  );
  const graph = await loadCurrentGraph(input, deps);
  const affected = affectedFromPreviousGraph.filter((affectedPr) =>
    graph.nodes.has(affectedPr)
  );

  if (affected.length > 0) {
    await restackDescendants(input, deps, graph, affected);
  }

  return {
    graph,
    affected,
  };
}

async function restackDescendants(
  input: TrainRestackInput,
  deps: TrainRestackDeps,
  graph: OpenPrGraph,
  affected: readonly number[]
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
      throw new Error(
        `PR #${node.pr.number} has multiple open parents. Prtisan v1 requires a linear stack.`
      );
    }

    const rebased = await deps.git.createRebasedCommit({
      runId: input.runId,
      label: `restack-pr-${node.pr.number}`,
      branch: node.pr.headRefName,
      baseBranch: nextBase,
      oldBaseAnchorSha: node.pr.baseRefOid || undefined,
    });
    await verifyRestackCommit(
      input,
      deps,
      node.pr.number,
      rebased.commit,
      `restack-pr-${node.pr.number}`
    );
    const current = await deps.github.getPullRequest(
      input.config.repo,
      node.pr.number
    );
    if (
      current.headRefOid !== node.pr.headRefOid ||
      current.baseRefOid !== node.pr.baseRefOid
    ) {
      throw new Error(
        `PR #${node.pr.number} changed during descendant restack; nothing was pushed.`
      );
    }
    await deps.git.pushVerifiedCommit({
      branch: node.pr.headRefName,
      commit: rebased.commit,
      expectedRemoteSha: node.pr.headRefOid,
    });

    if (node.pr.baseRefName !== nextBase) {
      await deps.github.editPullRequestBase(
        input.config.repo,
        node.pr.number,
        nextBase
      );
      deps.log?.(
        `Retargeted PR #${node.pr.number} from ${node.pr.baseRefName} to ${nextBase} at ${rebased.nextBaseAnchorSha}`
      );
    }
  }
}

async function verifyRestackCommit(
  input: TrainRestackInput,
  deps: TrainRestackDeps,
  prNumber: number,
  commit: string,
  label: string
): Promise<void> {
  if (!deps.runtime || !deps.verification) {
    throw new Error(
      `PR #${prNumber} restack requires an authoritative runtime and host verification runner.`
    );
  }
  const runtime = await deps.runtime.prepare({
    cwd: input.cwd,
    ref: commit,
    config: input.config,
  });
  const result = await deps.verification.verify({
    cwd: input.cwd,
    runId: input.runId,
    label,
    ref: commit,
    config: input.config,
    runtime,
  });
  if (result.status !== "passed") {
    const failed = result.commands.find((command) => command.exitCode !== 0);
    throw new Error(
      `PR #${prNumber} restack failed host verification: ${
        failed
          ? `${failed.name} exited ${failed.exitCode}: ${failed.output}`
          : result.status
      }`
    );
  }
}

function nextBaseBranch(
  config: AgentTrainConfig,
  pr: PullRequest,
  openBlockerBranches: readonly string[]
): string {
  if (openBlockerBranches.length === 0) return config.targetBranch;
  if (openBlockerBranches.length === 1) return openBlockerBranches[0] as string;
  throw new Error(
    `PR #${pr.number} has multiple open parents. Prtisan v1 requires a linear stack.`
  );
}

async function loadCurrentGraph(
  input: Pick<TrainRestackInput, "config">,
  deps: Pick<TrainRestackDeps, "github">
): Promise<OpenPrGraph> {
  return loadOpenPrGraph({
    github: deps.github,
    repo: input.config.repo,
    targetBranch: input.config.targetBranch,
    concurrency: input.config.concurrency.github,
  });
}
