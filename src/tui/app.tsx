import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useReducer, useState } from "react";

import type { MergeResult } from "@/commands/merge.js";
import type { ValidateResult } from "@/commands/validate.js";
import type { OpenPrGraph, OpenPrNode } from "@/open-pr-graph.js";
import type { RuntimeReadinessDiagnostic } from "@/preflight.js";

import type { TuiContext, TuiRuntime } from "./runtime.js";
import {
  initialTuiModel,
  isActionDisabled,
  labelForAction,
  selectedAction,
  TUI_ACTIONS,
  type TuiAction,
  type TuiModel,
  tuiModelUpdateFromRuntimeEvent,
  updateTuiModel,
} from "./state.js";

export interface AgentTrainTuiProps {
  readonly runtime: TuiRuntime;
  readonly autoRefresh?: boolean;
  readonly initialContext?: TuiContext;
  readonly initialGraph?: OpenPrGraph;
  readonly initialDiagnostics?: readonly RuntimeReadinessDiagnostic[];
  readonly initialModel?: TuiModel;
}

export function AgentTrainTui({
  runtime,
  autoRefresh = true,
  initialContext,
  initialGraph,
  initialDiagnostics,
  initialModel = initialTuiModel,
}: AgentTrainTuiProps) {
  const app = useApp();
  const [model, dispatch] = useReducer(updateTuiModel, initialModel);
  const [context, setContext] = useState<TuiContext | undefined>(
    initialContext
  );
  const [graph, setGraph] = useState<OpenPrGraph | undefined>(initialGraph);
  const [diagnostics, setDiagnostics] = useState<
    readonly RuntimeReadinessDiagnostic[] | undefined
  >(initialDiagnostics);

  const refreshAfterMutation = useCallback(async () => {
    const snapshot = await runtime.loadGraph();
    setContext(snapshot.context);
    setGraph(snapshot.graph);
  }, [runtime]);

  const runAction = useCallback(
    async (action: TuiAction) => {
      if (action === "quit") {
        app.exit(0);
        return;
      }

      try {
        if (action === "refresh") {
          const snapshot = await runtime.loadGraph();
          setContext(snapshot.context);
          setGraph(snapshot.graph);
        } else if (action === "preflight") {
          setDiagnostics(await runtime.preflight());
        } else if (action === "validate") {
          const result = await runtime.validate();
          await refreshAfterMutation();
          dispatch({
            type: "log",
            message: summarizeValidationResult(result),
          });
        } else if (action === "merge") {
          const result = await runtime.merge();
          await refreshAfterMutation();
          dispatch({ type: "log", message: summarizeMergeResult(result) });
        }
      } catch {
        // Runtime events already carry the displayable error.
      }
    },
    [app, refreshAfterMutation, runtime]
  );

  useEffect(
    () =>
      runtime.subscribe((event) => {
        const update = tuiModelUpdateFromRuntimeEvent(event);
        if (update) dispatch(update);
        if (event.type === "preflight") setDiagnostics(event.diagnostics);
        if (event.type === "graph") {
          setContext(event.snapshot.context);
          setGraph(event.snapshot.graph);
        }
      }),
    [runtime]
  );

  useEffect(() => {
    if (autoRefresh) void runAction("refresh");
  }, [autoRefresh, runAction]);

  useInput((input, key) => {
    if (model.runningAction) return;

    if (model.pendingConfirmation) {
      if (input.toLowerCase() === "y") {
        const confirmed = model.pendingConfirmation;
        dispatch({ type: "cancel-confirmation" });
        void runAction(confirmed);
      } else if (input.toLowerCase() === "n" || key.escape) {
        dispatch({ type: "cancel-confirmation" });
      }
      return;
    }

    if (key.downArrow || input === "j") {
      dispatch({ type: "select-next" });
      return;
    }
    if (key.upArrow || input === "k") {
      dispatch({ type: "select-previous" });
      return;
    }

    const shortcut = shortcutAction(input);
    if (shortcut) {
      requestOrRun(shortcut);
      return;
    }

    if (key.return) requestOrRun(selectedAction(model));
  });

  const requestOrRun = (action: TuiAction): void => {
    const next = updateTuiModel(model, { type: "request-action", action });
    dispatch({ type: "request-action", action });
    if (!next.pendingConfirmation && next === model) {
      void runAction(action);
    }
  };

  return (
    <DashboardView
      context={context}
      diagnostics={diagnostics}
      graph={graph}
      model={model}
    />
  );
}

export interface DashboardViewProps {
  readonly model: TuiModel;
  readonly context?: TuiContext;
  readonly graph?: OpenPrGraph;
  readonly diagnostics?: readonly RuntimeReadinessDiagnostic[];
}

export function DashboardView({
  model,
  context,
  graph,
  diagnostics,
}: DashboardViewProps) {
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Agent Train</Text>
        <Text>
          Repo: {context?.config.repo ?? "not loaded"} | Target:{" "}
          {context?.config.targetBranch ?? "not loaded"} | CWD:{" "}
          {context?.cwd ?? "not loaded"}
        </Text>
      </Box>

      <ActionBar model={model} />

      {model.pendingConfirmation ? (
        <Box borderStyle="single" paddingX={1}>
          <Text color="yellow">
            Confirm {labelForAction(model.pendingConfirmation)}: press y to run
            or n to cancel.
          </Text>
        </Box>
      ) : null}

      {model.lastError ? <Text color="red">{model.lastError}</Text> : null}
      {model.lastResult ? <Text color="green">{model.lastResult}</Text> : null}

      <Box flexDirection="column">
        <Text bold>Preflight</Text>
        {preflightLines(diagnostics).map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold>Open PR Train</Text>
        {graphLines(graph).map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold>Log</Text>
        {model.logs.length === 0 ? <Text dimColor>No events yet.</Text> : null}
        {model.logs.map((entry, index) => (
          <Text key={`${index}-${entry.message}`}>{entry.message}</Text>
        ))}
      </Box>

      <Text dimColor>
        Use up/down or k/j, Enter to select, r/p/v/m shortcuts, q to quit.
      </Text>
    </Box>
  );
}

function ActionBar({ model }: { readonly model: TuiModel }) {
  return (
    <Box gap={1}>
      {TUI_ACTIONS.map((action, index) => {
        const disabled = isActionDisabled(action, model);
        const selected = model.selectedIndex === index;
        return (
          <Text
            color={disabled ? "gray" : selected ? "cyan" : undefined}
            inverse={selected && !disabled}
            key={action}
          >
            {" "}
            {model.runningAction === action ? "*" : " "}
            {labelForAction(action)}{" "}
          </Text>
        );
      })}
    </Box>
  );
}

function graphLines(graph?: OpenPrGraph): string[] {
  if (!graph) return ["No PR train loaded."];
  if (graph.topologicalOrder.length === 0) return ["No open PRs."];

  return graph.layers.flatMap((layer, layerIndex) =>
    layer.map((prNumber) => {
      const node = graph.nodes.get(prNumber);
      return node
        ? `L${layerIndex + 1} ${formatNode(node)}`
        : `L${layerIndex + 1} #${prNumber}`;
    })
  );
}

function formatNode(node: OpenPrNode): string {
  const draft = node.pr.isDraft ? " draft" : "";
  const issue = node.issue ? ` issue #${node.issue.number}` : " standards";
  const blockers =
    node.blockers.length > 0 ? ` blockers ${node.blockers.join(",")}` : "";
  return `#${node.pr.number}${draft} ${node.validation.state}${issue} ${node.pr.headRefName}->${node.pr.baseRefName}${blockers}`;
}

function preflightLines(
  diagnostics?: readonly RuntimeReadinessDiagnostic[]
): string[] {
  if (!diagnostics) return ["Not run yet."];
  return diagnostics.map((item) => {
    const details = item.details ? ` - ${item.details}` : "";
    return `${item.status}: ${item.name}${details}`;
  });
}

function shortcutAction(input: string): TuiAction | undefined {
  switch (input.toLowerCase()) {
    case "r":
      return "refresh";
    case "p":
      return "preflight";
    case "v":
      return "validate";
    case "m":
      return "merge";
    case "q":
      return "quit";
    default:
      return undefined;
  }
}

function summarizeValidationResult(result: ValidateResult): string {
  return `Validation result: ${result.pullRequests.length} PR(s), ${result.issues.length} issue(s).`;
}

function summarizeMergeResult(result: MergeResult): string {
  return `Merge result: ${result.merged.length} PR(s) merged.`;
}
