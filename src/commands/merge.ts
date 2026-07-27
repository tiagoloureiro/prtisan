import type { AgentRunner } from "@/agent.js";
import { runIdFromDate } from "@/branching.js";
import { GitClient } from "@/git.js";
import { GitHubClient } from "@/github.js";
import {
  preparePullRequestForMerge,
  type PullRequestValidationGateResult,
} from "@/merge-readiness.js";
import { loadOpenPrGraph, type OpenPrGraph } from "@/open-pr-graph.js";
import type { RepairAttemptStore } from "@/repair-attempt-store.js";
import { appendRunEvent, writeRunRecord } from "@/run-record.js";
import type { RuntimeProvider, VerificationRunner } from "@/runtime.js";
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
  readonly runtime?: RuntimeProvider;
  readonly verification?: VerificationRunner;
  readonly repairAttempts?: RepairAttemptStore;
  readonly validatePullRequests?: (
    pullNumbers: readonly number[]
  ) => Promise<PullRequestValidationGateResult>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
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

class MergeRunError extends Error {
  constructor(
    message: string,
    readonly merged: readonly MergedPullRequest[],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MergeRunError";
  }
}

export async function executeMerge(
  input: MergeInput,
  deps: MergeDeps
): Promise<MergeResult> {
  const runId = input.runId ?? runIdFromDate("merge");
  const startedAt = new Date().toISOString();
  await recordRun(input, deps, {
    schemaVersion: 2,
    runId,
    command: "merge",
    repo: input.config.repo,
    startedAt,
    status: "running",
  });
  await recordEvent(input, deps, runId, {
    type: "command_started",
    message: "Merge command started.",
  });
  try {
    const result = await executeMergeRun(input, deps, runId);
    await recordRun(input, deps, {
      schemaVersion: 2,
      runId,
      command: "merge",
      repo: input.config.repo,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "completed",
      result,
    });
    await recordEvent(input, deps, runId, {
      type: "command_completed",
      message: "Merge command completed.",
      data: { mergedPullRequests: result.merged.map((item) => item.number) },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRun(input, deps, {
      schemaVersion: 2,
      runId,
      command: "merge",
      repo: input.config.repo,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "failed",
      error: message,
      result:
        error instanceof MergeRunError
          ? { repo: input.config.repo, merged: error.merged }
          : undefined,
    });
    await recordEvent(input, deps, runId, {
      type: "command_failed",
      message,
    });
    throw error;
  }
}

async function recordRun(
  input: MergeInput,
  deps: Pick<MergeDeps, "log">,
  record: Parameters<typeof writeRunRecord>[1]
): Promise<void> {
  await writeRunRecord(input.cwd, record).catch((error) => {
    deps.log?.(
      `Run record update failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

async function recordEvent(
  input: MergeInput,
  deps: Pick<MergeDeps, "log">,
  runId: string,
  event: Parameters<typeof appendRunEvent>[2]
): Promise<void> {
  await appendRunEvent(input.cwd, runId, event).catch((error) => {
    deps.log?.(
      `Run event update failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

async function executeMergeRun(
  input: MergeInput,
  deps: MergeDeps,
  runId: string
): Promise<MergeResult> {
  const merged: MergedPullRequest[] = [];
  try {
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
      if (restacked.affected.length > 0 && (input.validateAffected ?? true)) {
        await deps.validatePullRequests?.(restacked.affected);
      }

      graph = await loadCurrentGraph(input, deps);
    }
  } catch (error) {
    throw new MergeRunError(
      error instanceof Error ? error.message : String(error),
      [...merged],
      { cause: error }
    );
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
