import type { AgentRunner } from "@/agent.js";
import { SandcastleCodexRunner } from "@/agent.js";
import { executeMerge, type MergeResult } from "@/commands/merge.js";
import { executeValidate, type ValidateResult } from "@/commands/validate.js";
import { loadConfig } from "@/config.js";
import type { CommandRunner } from "@/exec.js";
import { BunCommandRunner } from "@/exec.js";
import { GitClient } from "@/git.js";
import { GitHubClient } from "@/github.js";
import { loadOpenPrGraph, type OpenPrGraph } from "@/open-pr-graph.js";
import {
  checkRuntimeReadiness,
  type RuntimeReadinessDiagnostic,
} from "@/preflight.js";
import { pruneRuntimeArtifacts } from "@/retention.js";
import type { AgentTrainConfig } from "@/types.js";

export type TuiRuntimeAction = "refresh" | "preflight" | "validate" | "merge";

export interface TuiRuntimeOptions {
  readonly cwd: string;
  readonly configPath?: string;
  readonly repo?: string;
  readonly targetBranch?: string;
  readonly repair?: boolean;
  readonly validateAffected?: boolean;
}

export interface TuiContext {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
}

export interface TuiGraphSnapshot {
  readonly context: TuiContext;
  readonly graph: OpenPrGraph;
}

export type TuiProgressEvent =
  | {
      readonly type: "action";
      readonly action: TuiRuntimeAction;
      readonly status: "started" | "completed" | "failed";
      readonly message?: string;
    }
  | {
      readonly type: "log";
      readonly action?: TuiRuntimeAction;
      readonly message: string;
    }
  | {
      readonly type: "preflight";
      readonly diagnostics: readonly RuntimeReadinessDiagnostic[];
    }
  | {
      readonly type: "graph";
      readonly snapshot: TuiGraphSnapshot;
    };

export interface TuiRuntime {
  subscribe(listener: (event: TuiProgressEvent) => void): () => void;
  loadGraph(): Promise<TuiGraphSnapshot>;
  preflight(): Promise<readonly RuntimeReadinessDiagnostic[]>;
  validate(): Promise<ValidateResult>;
  merge(): Promise<MergeResult>;
}

export interface TuiRuntimeDeps {
  readonly runner?: CommandRunner;
  readonly github?: GitHubClient;
  readonly git?: GitClient;
  readonly agent?: AgentRunner;
  readonly loadConfig?: typeof loadConfig;
  readonly loadGraph?: typeof loadOpenPrGraph;
  readonly checkReadiness?: typeof checkRuntimeReadiness;
  readonly pruneArtifacts?: typeof pruneRuntimeArtifacts;
  readonly validateCommand?: typeof executeValidate;
  readonly mergeCommand?: typeof executeMerge;
}

export class TuiPreflightError extends Error {
  readonly diagnostics: readonly RuntimeReadinessDiagnostic[];

  constructor(diagnostics: readonly RuntimeReadinessDiagnostic[]) {
    super(
      `Runtime readiness failed for ${diagnostics.filter((item) => item.status === "failed").length} check(s).`
    );
    this.name = "TuiPreflightError";
    this.diagnostics = diagnostics;
  }
}

export function createAgentTrainRuntime(
  options: TuiRuntimeOptions,
  deps: TuiRuntimeDeps = {}
): TuiRuntime {
  const listeners = new Set<(event: TuiProgressEvent) => void>();
  const runner = deps.runner ?? new BunCommandRunner();
  const github = deps.github ?? new GitHubClient(runner, options.cwd);
  const agent = deps.agent ?? new SandcastleCodexRunner();
  let contextPromise: Promise<TuiContext> | undefined;

  const emit = (event: TuiProgressEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const getContext = async (): Promise<TuiContext> => {
    contextPromise ??= (deps.loadConfig ?? loadConfig)(
      options.cwd,
      options.configPath,
      {
        repo: options.repo,
        targetBranch: options.targetBranch,
      }
    ).then((config) => ({ cwd: options.cwd, config }));
    return contextPromise;
  };

  const getGit = async (): Promise<GitClient> =>
    deps.git ?? new GitClient(runner, options.cwd, (await getContext()).config);

  const logFor =
    (action: TuiRuntimeAction) =>
    (message: string): void => {
      emit({ type: "log", action, message });
    };

  const runReadiness = async (): Promise<
    readonly RuntimeReadinessDiagnostic[]
  > => {
    const context = await getContext();
    const diagnostics = await (deps.checkReadiness ?? checkRuntimeReadiness)({
      cwd: context.cwd,
      config: context.config,
      runner,
      github,
    });
    emit({ type: "preflight", diagnostics });
    return diagnostics;
  };

  const assertReady = async (): Promise<void> => {
    const diagnostics = await runReadiness();
    if (diagnostics.some((item) => item.status === "failed")) {
      throw new TuiPreflightError(diagnostics);
    }
  };

  const prune = async (action: TuiRuntimeAction): Promise<void> => {
    const context = await getContext();
    await (deps.pruneArtifacts ?? pruneRuntimeArtifacts)({
      cwd: context.cwd,
      config: context.config,
      runner,
    }).catch((error) => {
      logFor(action)(
        `Retention pruning skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async loadGraph() {
      emit({ type: "action", action: "refresh", status: "started" });
      try {
        const context = await getContext();
        const graph = await (deps.loadGraph ?? loadOpenPrGraph)({
          github,
          repo: context.config.repo,
          targetBranch: context.config.targetBranch,
          concurrency: context.config.concurrency.github,
        });
        const snapshot = { context, graph };
        emit({ type: "graph", snapshot });
        emit({
          type: "action",
          action: "refresh",
          status: "completed",
          message: `Loaded ${graph.topologicalOrder.length} open PR(s).`,
        });
        return snapshot;
      } catch (error) {
        emit({
          type: "action",
          action: "refresh",
          status: "failed",
          message: errorMessage(error),
        });
        throw error;
      }
    },

    async preflight() {
      emit({ type: "action", action: "preflight", status: "started" });
      try {
        const diagnostics = await runReadiness();
        emit({
          type: "action",
          action: "preflight",
          status: diagnostics.some((item) => item.status === "failed")
            ? "failed"
            : "completed",
          message: preflightSummary(diagnostics),
        });
        return diagnostics;
      } catch (error) {
        emit({
          type: "action",
          action: "preflight",
          status: "failed",
          message: errorMessage(error),
        });
        throw error;
      }
    },

    async validate() {
      emit({ type: "action", action: "validate", status: "started" });
      try {
        await assertReady();
        await prune("validate");
        const context = await getContext();
        const result = await (deps.validateCommand ?? executeValidate)(
          {
            cwd: context.cwd,
            config: context.config,
            repair: options.repair ?? true,
          },
          {
            github,
            git: await getGit(),
            agent,
            log: logFor("validate"),
          }
        );
        emit({
          type: "action",
          action: "validate",
          status: "completed",
          message: validationSummary(result),
        });
        return result;
      } catch (error) {
        emit({
          type: "action",
          action: "validate",
          status: "failed",
          message: errorMessage(error),
        });
        throw error;
      }
    },

    async merge() {
      emit({ type: "action", action: "merge", status: "started" });
      try {
        await assertReady();
        await prune("merge");
        const context = await getContext();
        const git = await getGit();
        const validatePullRequests = async (
          pullNumbers: readonly number[]
        ): Promise<void> => {
          await (deps.validateCommand ?? executeValidate)(
            {
              cwd: context.cwd,
              config: context.config,
              pullNumbers,
              repair: true,
            },
            {
              github,
              git,
              agent,
              log: logFor("merge"),
            }
          );
        };
        const result = await (deps.mergeCommand ?? executeMerge)(
          {
            cwd: context.cwd,
            config: context.config,
            validateAffected: options.validateAffected ?? true,
          },
          {
            github,
            git,
            agent,
            validatePullRequests,
            log: logFor("merge"),
          }
        );
        emit({
          type: "action",
          action: "merge",
          status: "completed",
          message: mergeSummary(result),
        });
        return result;
      } catch (error) {
        emit({
          type: "action",
          action: "merge",
          status: "failed",
          message: errorMessage(error),
        });
        throw error;
      }
    },
  };
}

function preflightSummary(
  diagnostics: readonly RuntimeReadinessDiagnostic[]
): string {
  const failed = diagnostics.filter((item) => item.status === "failed").length;
  return failed === 0
    ? "Runtime readiness passed."
    : `Runtime readiness failed for ${failed} check(s).`;
}

function validationSummary(result: ValidateResult): string {
  const failedPrs = result.pullRequests.filter(
    (item) => item.status === "validation_failed"
  ).length;
  const failedIssues = result.issues.filter(
    (item) => item.status === "validation_failed"
  ).length;
  return `Validated ${result.pullRequests.length} PR(s) and ${result.issues.length} issue(s); ${failedPrs + failedIssues} failed.`;
}

function mergeSummary(result: MergeResult): string {
  const merged = result.merged.map((pr) => `#${pr.number}`).join(", ");
  return result.merged.length === 0
    ? "No open PRs were merged."
    : `Merged ${result.merged.length} PR(s): ${merged}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
