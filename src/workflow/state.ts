import type {
  PullRequestAttempt,
  WorkflowEvent,
  WorkflowSnapshot,
} from "./types.js";

export function initialSnapshot(
  event: Extract<WorkflowEvent, { type: "plan_created" }>
): WorkflowSnapshot {
  return {
    planId: event.planId,
    repositoryKey: event.repositoryKey,
    outcome: "planned",
    updatedAt: event.at,
    merged: [],
    attempts: event.pullRequests.map((pr): PullRequestAttempt => ({
      number: pr.number,
      outcome: "pending",
      headRefOid: pr.headRefOid,
      baseRefOid: pr.baseRefOid,
      repairCandidates: 0,
      causeAttempts: {},
      policyDigest: pr.policyDigest,
      manifestDigest: pr.manifestDigest,
      manifest: pr.manifest,
      requiredChecks: pr.requiredChecks,
    })),
    nextAction: `Run prtisan apply ${event.planId}.`,
  };
}

export function reduceWorkflow(
  events: readonly WorkflowEvent[]
): WorkflowSnapshot {
  const first = events[0];
  if (!first || first.type !== "plan_created") {
    throw new Error("Workflow event stream must begin with plan_created.");
  }

  return events.slice(1).reduce(reduceEvent, initialSnapshot(first));
}

function reduceEvent(
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent
): WorkflowSnapshot {
  if (event.type === "plan_created") {
    throw new Error("plan_created may only appear once.");
  }
  if (event.type === "apply_started") {
    return {
      ...snapshot,
      outcome: "running",
      updatedAt: event.at,
      blocker: undefined,
      nextAction: "Prtisan is applying the plan.",
    };
  }
  if (event.type === "attempt_changed") {
    return {
      ...snapshot,
      updatedAt: event.at,
      attempts: snapshot.attempts.map((attempt) =>
        attempt.number === event.attempt.number ? event.attempt : attempt
      ),
    };
  }
  if (event.type === "pull_request_merged") {
    return {
      ...snapshot,
      updatedAt: event.at,
      merged: snapshot.merged.includes(event.pullNumber)
        ? snapshot.merged
        : [...snapshot.merged, event.pullNumber],
    };
  }
  if (event.type === "workflow_blocked") {
    const partial = snapshot.merged.length > 0;
    return {
      ...snapshot,
      outcome:
        partial && event.outcome !== "stale"
          ? "partially_completed"
          : event.outcome,
      updatedAt: event.at,
      blocker: event.blocker,
      nextAction: nextActionFor(event.outcome, snapshot.planId),
    };
  }
  return {
    ...snapshot,
    outcome: "completed",
    updatedAt: event.at,
    blocker: undefined,
    nextAction: "The planned open PR train is complete.",
  };
}

function nextActionFor(
  outcome: Extract<WorkflowEvent, { type: "workflow_blocked" }>["outcome"],
  planId: string
): string {
  if (outcome === "stale" || outcome === "invalid_plan") {
    return "Create a fresh plan; authoritative train inputs changed.";
  }
  if (outcome === "waiting_external") {
    return `Resolve the external gate, then rerun prtisan apply ${planId}.`;
  }
  if (outcome === "repair_exhausted") {
    return "A human must update the PR before a fresh plan can continue.";
  }
  if (outcome === "needs_human") {
    return `Resolve the reported ambiguity or approval, then rerun prtisan apply ${planId}.`;
  }
  return `Correct the infrastructure failure, then rerun prtisan apply ${planId}.`;
}
