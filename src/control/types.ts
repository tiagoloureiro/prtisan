export type ProjectCapability =
  "docker" | "github" | "github_auth" | "prtisan_setup";

export interface ProjectCapabilityStatus {
  readonly capability: ProjectCapability;
  readonly available: boolean;
  readonly details: string;
}

export interface Project {
  readonly id: string;
  readonly cwd: string;
  readonly name: string;
  readonly repository?: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationProfile {
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
}

export type ConversationStatus =
  "active" | "running" | "published" | "archived";

export interface Conversation {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly profile: ConversationProfile;
  readonly status: ConversationStatus;
  readonly sessionId?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
  readonly publishedSha?: string;
  readonly rollingSummary?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ConversationMessageRole = "user" | "assistant" | "system";

export interface ConversationAttachment {
  readonly kind: "file" | "image";
  readonly name: string;
  readonly path: string;
  readonly digest: string;
  readonly mediaType?: string;
}

export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: ConversationMessageRole;
  readonly text: string;
  readonly status: "completed" | "cancelled" | "failed" | "interrupted";
  readonly attachments: readonly ConversationAttachment[];
  readonly events: readonly ConversationActivity[];
  readonly createdAt: string;
}

export interface ConversationActivity {
  readonly type:
    "status" | "command" | "tool" | "changed_files" | "usage" | "log";
  readonly summary: string;
  readonly detail?: unknown;
}

export type ActionProposalKind =
  | "setup_plan"
  | "setup_apply"
  | "policy_upgrade"
  | "workflow_plan"
  | "workflow_apply"
  | "workflow_run"
  | "workflow_export"
  | "publish_pull_request"
  | "cleanup";

export interface ActionProposal {
  readonly id: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly kind: ActionProposalKind;
  readonly title: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly preconditionDigest: string;
  readonly status: "pending" | "confirmed" | "rejected" | "stale" | "completed";
  readonly createdAt: string;
}

export type WorkerJobKind = "conversation_turn" | "workflow" | "cleanup";
export type WorkerJobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface WorkerJob {
  readonly id: string;
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly kind: WorkerJobKind;
  readonly status: WorkerJobStatus;
  readonly input: unknown;
  readonly result?: unknown;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationTurnJobInput {
  readonly text: string;
  readonly attachmentPaths: readonly string[];
  readonly attachments?: readonly ConversationAttachment[];
  readonly messageId?: string;
}

export interface GlobalSettings {
  readonly schemaVersion: 1;
  readonly defaultConversationProfile: ConversationProfile;
  readonly maxConcurrentTurns?: number;
  readonly workerIdleTimeoutMs: number;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  schemaVersion: 1,
  defaultConversationProfile: {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  },
  workerIdleTimeoutMs: 15 * 60 * 1000,
};
