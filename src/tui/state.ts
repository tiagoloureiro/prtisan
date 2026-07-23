import type { TuiProgressEvent, TuiRuntimeAction } from "./runtime.js";

export type TuiAction = TuiRuntimeAction | "quit";

export const TUI_ACTIONS = [
  "refresh",
  "preflight",
  "validate",
  "merge",
  "quit",
] as const satisfies readonly TuiAction[];

export interface TuiLogEntry {
  readonly message: string;
}

export interface TuiModel {
  readonly selectedIndex: number;
  readonly runningAction?: TuiRuntimeAction;
  readonly pendingConfirmation?: Extract<TuiAction, "validate" | "merge">;
  readonly logs: readonly TuiLogEntry[];
  readonly lastResult?: string;
  readonly lastError?: string;
}

export type TuiModelUpdate =
  | { readonly type: "select-next" }
  | { readonly type: "select-previous" }
  | { readonly type: "request-action"; readonly action: TuiAction }
  | { readonly type: "cancel-confirmation" }
  | { readonly type: "action-started"; readonly action: TuiRuntimeAction }
  | {
      readonly type: "action-completed";
      readonly action: TuiRuntimeAction;
      readonly message?: string;
    }
  | {
      readonly type: "action-failed";
      readonly action: TuiRuntimeAction;
      readonly message?: string;
    }
  | { readonly type: "log"; readonly message: string };

export const initialTuiModel: TuiModel = {
  selectedIndex: 0,
  logs: [],
};

export function updateTuiModel(
  model: TuiModel,
  update: TuiModelUpdate
): TuiModel {
  if (update.type === "select-next") {
    return selectRelative(model, 1);
  }
  if (update.type === "select-previous") {
    return selectRelative(model, -1);
  }
  if (update.type === "request-action") {
    if (isActionDisabled(update.action, model)) return model;
    if (actionNeedsConfirmation(update.action)) {
      return {
        ...model,
        pendingConfirmation: update.action,
        lastError: undefined,
      };
    }
    return model;
  }
  if (update.type === "cancel-confirmation") {
    return {
      ...model,
      pendingConfirmation: undefined,
    };
  }
  if (update.type === "action-started") {
    return {
      ...model,
      runningAction: update.action,
      pendingConfirmation: undefined,
      lastError: undefined,
      lastResult: undefined,
      logs: appendLog(model.logs, `${labelForAction(update.action)} started.`),
    };
  }
  if (update.type === "action-completed") {
    return {
      ...model,
      runningAction: undefined,
      lastResult: update.message,
      logs: appendLog(
        model.logs,
        update.message ?? `${labelForAction(update.action)} completed.`
      ),
    };
  }
  if (update.type === "action-failed") {
    const message =
      update.message ?? `${labelForAction(update.action)} failed.`;
    return {
      ...model,
      runningAction: undefined,
      lastError: message,
      logs: appendLog(model.logs, message),
    };
  }
  return {
    ...model,
    logs: appendLog(model.logs, update.message),
  };
}

export function updateTuiModelFromRuntimeEvent(
  model: TuiModel,
  event: TuiProgressEvent
): TuiModel {
  const update = tuiModelUpdateFromRuntimeEvent(event);
  return update ? updateTuiModel(model, update) : model;
}

export function tuiModelUpdateFromRuntimeEvent(
  event: TuiProgressEvent
): TuiModelUpdate | undefined {
  if (event.type === "log") {
    return { type: "log", message: event.message };
  }
  if (event.type !== "action") return undefined;
  if (event.status === "started") {
    return {
      type: "action-started",
      action: event.action,
    };
  }
  if (event.status === "completed") {
    return {
      type: "action-completed",
      action: event.action,
      message: event.message,
    };
  }
  return {
    type: "action-failed",
    action: event.action,
    message: event.message,
  };
}

export function selectedAction(
  model: Pick<TuiModel, "selectedIndex">
): TuiAction {
  return TUI_ACTIONS[model.selectedIndex] ?? "refresh";
}

export function actionNeedsConfirmation(
  action: TuiAction
): action is Extract<TuiAction, "validate" | "merge"> {
  return action === "validate" || action === "merge";
}

export function isActionDisabled(
  action: TuiAction,
  model: Pick<TuiModel, "runningAction">
): boolean {
  return Boolean(model.runningAction) && action !== model.runningAction;
}

export function labelForAction(action: TuiAction): string {
  switch (action) {
    case "refresh":
      return "Refresh";
    case "preflight":
      return "Preflight";
    case "validate":
      return "Validate";
    case "merge":
      return "Merge";
    case "quit":
      return "Quit";
  }
}

function selectRelative(model: TuiModel, offset: number): TuiModel {
  if (model.runningAction) return model;
  const total = TUI_ACTIONS.length;
  return {
    ...model,
    selectedIndex: (model.selectedIndex + offset + total) % total,
  };
}

function appendLog(
  logs: readonly TuiLogEntry[],
  message: string
): readonly TuiLogEntry[] {
  return [...logs, { message }].slice(-10);
}
