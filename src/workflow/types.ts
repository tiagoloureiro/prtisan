import type { Issue, PullRequest } from "@/types.js";

export type WorkflowOutcome =
  | "planned"
  | "running"
  | "completed"
  | "partially_completed"
  | "stale"
  | "waiting_external"
  | "needs_human"
  | "repair_exhausted"
  | "invalid_plan"
  | "infrastructure_failed";

export type PullRequestAttemptOutcome =
  | "pending"
  | "promoting_draft"
  | "preparing"
  | "ready"
  | "merging"
  | "merged"
  | "restacking"
  | "stale"
  | "waiting_external"
  | "needs_human"
  | "repair_exhausted"
  | "infrastructure_failed";

export interface FrozenPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly baseRefOid: string;
  readonly isDraft: boolean;
  readonly reviewDecision?: string;
  readonly checkStateDigest: string;
  readonly parent?: number;
  readonly children: readonly number[];
  readonly issue?: Pick<Issue, "number" | "title" | "body" | "url">;
  readonly contract:
    | {
        readonly kind: "issue" | "pr_body";
        readonly digest: string;
        readonly text: string;
      }
    | {
        readonly kind: "none";
        readonly digest: string;
      };
  readonly policyDigest: string;
  readonly manifestDigest: string;
  readonly manifest: unknown;
  readonly requiredChecks: readonly string[];
  readonly snapshotKey: string;
}

export interface TrainPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly repositoryKey: string;
  readonly cwd: string;
  readonly repo: string;
  readonly targetBranch: string;
  readonly createdAt: string;
  readonly manifestDigest: string;
  readonly manifest: unknown;
  readonly pullRequests: readonly FrozenPullRequest[];
  readonly topologicalOrder: readonly number[];
  readonly planDigest: string;
}

export interface WorkflowBlocker {
  readonly category:
    | "contract"
    | "human_review"
    | "github_checks"
    | "infrastructure"
    | "credentials"
    | "policy"
    | "stale"
    | "repair_budget"
    | "restack_conflict";
  readonly message: string;
  readonly evidence?: string;
  readonly remediation?: WorkflowRemediation;
  readonly external: boolean;
}

export interface CodexLoginRemediation {
  readonly kind: "codex_login";
  readonly codexHome: string;
  readonly command: string;
}

export type WorkflowRemediation = CodexLoginRemediation;

export interface PullRequestAttempt {
  readonly number: number;
  readonly outcome: PullRequestAttemptOutcome;
  readonly headRefOid: string;
  readonly baseRefOid: string;
  readonly repairCandidates: number;
  readonly causeAttempts: Readonly<Record<string, number>>;
  readonly policyDigest: string;
  readonly manifestDigest: string;
  readonly manifest: unknown;
  readonly requiredChecks: readonly string[];
  readonly blocker?: WorkflowBlocker;
}

export interface WorkflowSnapshot {
  readonly planId: string;
  readonly repositoryKey: string;
  readonly outcome: WorkflowOutcome;
  readonly updatedAt: string;
  readonly merged: readonly number[];
  readonly attempts: readonly PullRequestAttempt[];
  readonly blocker?: WorkflowBlocker;
  readonly nextAction: string;
}

export type WorkflowEvent =
  | {
      readonly type: "plan_created";
      readonly at: string;
      readonly planId: string;
      readonly repositoryKey: string;
      readonly pullRequests: readonly FrozenPullRequest[];
    }
  | {
      readonly type: "apply_started";
      readonly at: string;
    }
  | {
      readonly type: "attempt_changed";
      readonly at: string;
      readonly attempt: PullRequestAttempt;
    }
  | {
      readonly type: "pull_request_merged";
      readonly at: string;
      readonly pullNumber: number;
    }
  | {
      readonly type: "workflow_blocked";
      readonly at: string;
      readonly outcome: Exclude<
        WorkflowOutcome,
        "planned" | "running" | "completed" | "partially_completed"
      >;
      readonly blocker: WorkflowBlocker;
    }
  | {
      readonly type: "workflow_completed";
      readonly at: string;
    };

export interface CurrentTrain {
  readonly pullRequests: readonly PullRequest[];
}

export interface PreparationResult {
  readonly kind:
    | "ready"
    | "stale"
    | "waiting_external"
    | "needs_human"
    | "repair_exhausted"
    | "infrastructure_failed";
  readonly pullRequest: PullRequest;
  readonly repairCandidates?: number;
  readonly causeAttempts?: Readonly<Record<string, number>>;
  readonly blocker?: WorkflowBlocker;
}

export interface RestackResult {
  readonly children: readonly {
    readonly number: number;
    readonly headRefOid: string;
    readonly baseRefOid: string;
    readonly policyDigest: string;
    readonly manifestDigest: string;
    readonly manifest: unknown;
    readonly requiredChecks: readonly string[];
  }[];
}
