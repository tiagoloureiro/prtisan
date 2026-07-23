import { describe, expect, test } from "bun:test";

import {
  initialTuiModel,
  selectedAction,
  updateTuiModel,
  updateTuiModelFromRuntimeEvent,
} from "@/tui/state.js";

describe("TUI state", () => {
  test("moves the selected action with wraparound", () => {
    const previous = updateTuiModel(initialTuiModel, {
      type: "select-previous",
    });
    expect(selectedAction(previous)).toBe("quit");

    const next = updateTuiModel(previous, { type: "select-next" });
    expect(selectedAction(next)).toBe("refresh");
  });

  test("requires confirmation before validate and merge", () => {
    const model = updateTuiModel(initialTuiModel, {
      type: "request-action",
      action: "validate",
    });

    expect(model.pendingConfirmation).toBe("validate");
    expect(
      updateTuiModel(model, { type: "cancel-confirmation" }).pendingConfirmation
    ).toBeUndefined();
  });

  test("does not change selection while an action is running", () => {
    const running = updateTuiModel(initialTuiModel, {
      type: "action-started",
      action: "merge",
    });

    expect(updateTuiModel(running, { type: "select-next" }).selectedIndex).toBe(
      running.selectedIndex
    );
  });

  test("records success and failure runtime events", () => {
    const completed = updateTuiModelFromRuntimeEvent(initialTuiModel, {
      type: "action",
      action: "refresh",
      status: "completed",
      message: "Loaded 2 open PR(s).",
    });
    expect(completed.lastResult).toBe("Loaded 2 open PR(s).");

    const failed = updateTuiModelFromRuntimeEvent(completed, {
      type: "action",
      action: "validate",
      status: "failed",
      message: "Runtime readiness failed.",
    });
    expect(failed.lastError).toBe("Runtime readiness failed.");
  });
});
