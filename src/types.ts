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
  readonly remote: string;
  readonly models: {
    readonly repair: string;
    readonly review: string;
  };
  readonly reasoning: {
    readonly repair: ReasoningEffort;
    readonly review: ReasoningEffort;
  };
  readonly concurrency: {
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
