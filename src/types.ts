export type IssueState = "OPEN" | "CLOSED";

export interface IssueRef {
  readonly number: number;
  readonly title?: string;
  readonly state?: IssueState;
  readonly url?: string;
}

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly url: string;
  readonly labels: readonly string[];
  readonly blockedBy: readonly IssueRef[];
  readonly blocking: readonly IssueRef[];
  readonly parent?: IssueRef;
  readonly subIssues: readonly IssueRef[];
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export const AGENT_ROLES = [
  "standardsReview",
  "specReview",
  "repairVerification",
  "validationRepair",
  "ciRepair",
  "mergeStateRepair",
  "restackConflictRepair",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export interface ModelProfile {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
}

export type AgentRoleProfiles = Readonly<Record<AgentRole, ModelProfile>>;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

export interface CreditCost {
  readonly rateCardId: string;
  readonly credits: number;
}

export interface AgentInvocationMetrics {
  readonly role: AgentRole;
  readonly profile: ModelProfile;
  readonly promptChars: number;
  readonly agentDurationMs: number;
  readonly iterations: number;
  readonly retryCount: number;
  readonly cacheUsed?: boolean;
  readonly usage?: TokenUsage;
  readonly creditCost?: CreditCost;
}

export interface DockerMountConfig {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly?: boolean;
}

export interface SandboxCommandConfig {
  readonly name: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
}

export type ValidationScope = "prs" | "issues" | "all";
export type SessionRetentionPolicy = "none" | "failures" | "all";

export interface AgentTrainConfig {
  readonly repo: string;
  readonly targetBranch: string;
  readonly remote: string;
  readonly agentProfiles: AgentRoleProfiles;
  readonly concurrency: {
    readonly validate: number;
    readonly github: number;
  };
  readonly docker: {
    readonly imageName: string;
    readonly imagePolicy: "managed" | "external";
    readonly dockerfile: string;
    readonly context: string;
    readonly codexHome: string;
    readonly cpus?: number;
    readonly mounts: readonly DockerMountConfig[];
  };
  readonly runtime: {
    readonly autoProvision: boolean;
    readonly verificationMode: "auto" | "explicit";
    readonly probes: readonly SandboxCommandConfig[];
    readonly bootstrap?: SandboxCommandConfig;
    readonly verification: readonly SandboxCommandConfig[];
  };
  readonly validation: {
    readonly maxRepairRounds: number;
    readonly maxAgentRunsPerHead: number;
    readonly maxWallTimeMs: number;
    readonly promptCharBudget: number;
    readonly maxCheckLogChars: number;
    readonly maxCheckEvidenceChars: number;
    readonly checkStartTimeoutMs: number;
    readonly checkCompletionTimeoutMs: number;
    readonly leaseTtlMs: number;
    readonly cacheTtlDays: number;
  };
  readonly retention: {
    readonly ttlDays: number;
    readonly maxLogBytes: number;
    readonly keepSessions: boolean;
    readonly sessionPolicy: SessionRetentionPolicy;
    readonly maxRuns: number;
    readonly maxTotalBytes: number;
  };
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly isDraft?: boolean;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly baseRefOid: string;
  readonly headRefOid: string;
  readonly mergeStateStatus?: string;
  readonly reviewDecision?: string;
  readonly closingIssuesReferences: readonly IssueRef[];
  readonly latestReviews: readonly PullRequestReviewSummary[];
  readonly reviews: readonly PullRequestReviewSummary[];
  readonly comments: readonly PullRequestReviewSummary[];
  readonly statusCheckRollup?: readonly unknown[];
}

export interface PullRequestReviewSummary {
  readonly state: string;
  readonly body: string;
  readonly submittedAt?: string;
  readonly authorLogin?: string;
}

export interface PullRequestCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string;
  readonly detailsUrl?: string;
  readonly workflowName?: string;
  readonly runId?: string;
}

export interface PullRequestCheckEvidence extends PullRequestCheck {
  readonly logExcerpt?: string;
  readonly logError?: string;
}

export type ReviewAxis = "standards" | "spec";
export type FindingSeverity = "blocking" | "advisory";

export interface ReviewFinding {
  readonly axis: ReviewAxis;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly body: string;
  readonly findingId?: string;
  readonly rule?: string;
  readonly evidence?: string;
  readonly path?: string;
  readonly line?: number;
  readonly side?: "RIGHT" | "LEFT";
}

export interface ReviewReport {
  readonly axis: ReviewAxis;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly promptChars?: number;
  readonly durationMs?: number;
  readonly invocation?: AgentInvocationMetrics;
  readonly rawOutput?: string;
  readonly logFilePath?: string;
}

export interface RepairVerificationReport {
  readonly summary: string;
  readonly resolvedFindingIds: readonly string[];
  readonly findings: readonly ReviewFinding[];
  readonly promptChars?: number;
  readonly durationMs?: number;
  readonly invocation?: AgentInvocationMetrics;
  readonly rawOutput?: string;
  readonly logFilePath?: string;
}

export interface AgentRunOutcome {
  readonly branch: string;
  readonly commits: readonly string[];
  readonly stdout: string;
  readonly structuredOutput?: unknown;
  readonly logFilePath?: string;
  readonly sessionId?: string;
  readonly promptChars?: number;
  readonly durationMs?: number;
  readonly usage?: TokenUsage;
  readonly invocation?: AgentInvocationMetrics;
}

export interface VerificationResult {
  readonly status: "passed" | "failed" | "infra_failed";
  readonly commands: readonly {
    readonly name: string;
    readonly command: string;
    readonly exitCode: number;
    readonly durationMs: number;
    readonly timedOut: boolean;
    readonly output: string;
  }[];
}

export interface ValidationMetrics {
  readonly durationMs: number;
  readonly agentRuns: number;
  readonly cacheHits: number;
  readonly promptChars: number;
  readonly stageTimingsMs: Readonly<Record<string, number>>;
}

interface ValidationOutcomeBase {
  readonly snapshotKey: string;
  readonly metrics: ValidationMetrics;
  readonly verification?: VerificationResult;
}

export type ValidationOutcome =
  | (ValidationOutcomeBase & {
      readonly kind: "passed" | "repaired";
    })
  | (ValidationOutcomeBase & {
      readonly kind: "blocked" | "needs_human";
      readonly reason: string;
      readonly findings: readonly ReviewFinding[];
    })
  | (ValidationOutcomeBase & {
      readonly kind: "stale" | "infra_failed" | "budget_exhausted";
      readonly reason: string;
    });
