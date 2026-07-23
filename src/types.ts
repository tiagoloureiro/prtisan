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

export interface DockerMountConfig {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly?: boolean;
}

export interface AgentTrainConfig {
  readonly repo: string;
  readonly targetBranch: string;
  readonly issueQuery: string;
  readonly branchPrefix: string;
  readonly trainPrefix: string;
  readonly remote: string;
  readonly models: {
    readonly implementation: string;
    readonly repair: string;
    readonly review: string;
  };
  readonly reasoning: {
    readonly implementation: ReasoningEffort;
    readonly repair: ReasoningEffort;
    readonly review: ReasoningEffort;
  };
  readonly concurrency: {
    readonly implement: number;
    readonly validate: number;
    readonly github: number;
  };
  readonly docker: {
    readonly imageName: string;
    readonly codexHome: string;
    readonly cpus?: number;
    readonly mounts: readonly DockerMountConfig[];
  };
  readonly retention: {
    readonly ttlDays: number;
    readonly maxLogBytes: number;
    readonly keepSessions: boolean;
  };
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: string;
  readonly isDraft?: boolean;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly mergeStateStatus?: string;
  readonly reviewDecision?: string;
  readonly statusCheckRollup?: readonly unknown[];
}

export type IssueRunStatus =
  | "planned"
  | "blocked"
  | "implementing"
  | "pr_opened"
  | "validating"
  | "validated"
  | "validation_failed"
  | "merged";

export interface IssueTrainRecord {
  readonly issue: Issue;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseAnchorSha?: string;
  readonly blockers: readonly number[];
  readonly syntheticBase?: string;
  readonly status: IssueRunStatus;
  readonly pr?: Pick<
    PullRequest,
    "number" | "url" | "headRefName" | "baseRefName" | "headRefOid"
  >;
  readonly commits: readonly string[];
  readonly lastError?: string;
  readonly validation?: {
    readonly checkedAt: string;
    readonly blockingFindings: number;
    readonly advisoryFindings: number;
    readonly reviewEvent: "COMMENT" | "REQUEST_CHANGES";
    readonly repaired: boolean;
  };
}

export interface SyntheticBaseRecord {
  readonly branch: string;
  readonly issueNumber: number;
  readonly blockers: readonly number[];
  readonly status: "planned" | "created" | "failed" | "obsolete";
  readonly lastError?: string;
}

export interface TrainState {
  readonly trainId: string;
  readonly repo: string;
  readonly targetBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly issues: Record<string, IssueTrainRecord>;
  readonly syntheticBases: Record<string, SyntheticBaseRecord>;
}

export type ReviewAxis = "standards" | "spec";
export type FindingSeverity = "blocking" | "advisory";

export interface ReviewFinding {
  readonly axis: ReviewAxis;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
  readonly side?: "RIGHT" | "LEFT";
}

export interface ReviewReport {
  readonly axis: ReviewAxis;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export interface AgentRunOutcome {
  readonly branch: string;
  readonly commits: readonly string[];
  readonly stdout: string;
  readonly structuredOutput?: unknown;
  readonly logFilePath?: string;
  readonly sessionId?: string;
}
