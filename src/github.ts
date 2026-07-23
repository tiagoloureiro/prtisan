import type { CommandRunner } from "./exec.js";
import { mustRun, runJson } from "./exec.js";
import { writeText } from "./fs.js";
import type {
  Issue,
  IssueRef,
  PullRequest,
  PullRequestReviewSummary,
  ReviewFinding,
} from "./types.js";

const ISSUE_JSON_FIELDS = [
  "number",
  "title",
  "body",
  "state",
  "url",
  "labels",
  "blockedBy",
  "blocking",
  "parent",
  "subIssues",
].join(",");

const PR_JSON_FIELDS = [
  "number",
  "url",
  "title",
  "state",
  "isDraft",
  "body",
  "headRefName",
  "baseRefName",
  "baseRefOid",
  "headRefOid",
  "mergeStateStatus",
  "reviewDecision",
  "closingIssuesReferences",
  "latestReviews",
  "statusCheckRollup",
].join(",");

export interface CreateOrUpdatePrInput {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
}

export interface GitHubIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
}

export interface CreateIssueInput {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
}

export interface PullRequestReviewInput {
  readonly repo: string;
  readonly pullNumber: number;
  readonly commitId: string;
  readonly event: "COMMENT" | "REQUEST_CHANGES";
  readonly body: string;
  readonly comments: readonly {
    readonly path: string;
    readonly position: number;
    readonly body: string;
  }[];
}

export class GitHubClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly cwd: string
  ) {}

  async assertReady(): Promise<void> {
    const version = await mustRun(this.runner, "gh", ["--version"], {
      cwd: this.cwd,
    });
    const firstLine = version.stdout.split("\n")[0] ?? "";
    const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(firstLine);
    if (!match) {
      throw new Error(`Unable to parse GitHub CLI version from: ${firstLine}`);
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < 2 || (major === 2 && minor < 94)) {
      throw new Error(
        `GitHub CLI 2.94+ is required for native issue dependencies. Found: ${firstLine}`
      );
    }

    await mustRun(this.runner, "gh", ["auth", "status"], { cwd: this.cwd });
  }

  async getIssue(repo: string, issueNumber: number): Promise<Issue> {
    try {
      const raw = await runJson<unknown>(
        this.runner,
        "gh",
        [
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          repo,
          "--json",
          ISSUE_JSON_FIELDS,
        ],
        { cwd: this.cwd }
      );
      return normalizeIssue(raw);
    } catch (error) {
      throw enrichDependencyFieldError(error);
    }
  }

  async findIssueByBodyMarker(
    repo: string,
    marker: string
  ): Promise<GitHubIssueSummary | undefined> {
    const issues = await runJson<unknown[]>(
      this.runner,
      "gh",
      [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--search",
        `in:body ${marker}`,
        "--json",
        "number,title,url,state",
        "--limit",
        "1",
      ],
      { cwd: this.cwd }
    );
    return issues[0] ? normalizeIssueSummary(issues[0]) : undefined;
  }

  async listOpenIssues(repo: string): Promise<Issue[]> {
    try {
      const raw = await runJson<unknown[]>(
        this.runner,
        "gh",
        [
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--json",
          ISSUE_JSON_FIELDS,
          "--limit",
          "1000",
        ],
        { cwd: this.cwd }
      );
      return raw.map(normalizeIssue);
    } catch (error) {
      throw enrichDependencyFieldError(error);
    }
  }

  async createIssue(input: CreateIssueInput): Promise<GitHubIssueSummary> {
    const bodyFile = `/tmp/agent-train-setup-issue-${crypto.randomUUID()}.md`;
    await writeText(bodyFile, input.body);
    try {
      const result = await mustRun(
        this.runner,
        "gh",
        [
          "issue",
          "create",
          "--repo",
          input.repo,
          "--title",
          input.title,
          "--body-file",
          bodyFile,
        ],
        { cwd: this.cwd }
      );
      const url = result.stdout.trim();
      const number = Number(url.match(/\/issues\/(\d+)$/)?.[1]);
      if (!Number.isInteger(number)) {
        throw new Error(`Unable to parse created issue URL: ${url}`);
      }
      return {
        number,
        title: input.title,
        url,
        state: "OPEN",
      };
    } finally {
      await this.runner.run("rm", ["-f", bodyFile]);
    }
  }

  async createIssueComment(
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    await mustRun(
      this.runner,
      "gh",
      [
        "api",
        "--method",
        "POST",
        `/repos/${repo}/issues/${issueNumber}/comments`,
        "--input",
        "-",
      ],
      {
        cwd: this.cwd,
        input: JSON.stringify({ body }),
      }
    );
  }

  async getPullRequestByBranch(
    repo: string,
    branch: string,
    state: "open" | "all" = "all"
  ): Promise<PullRequest | undefined> {
    const prs = await runJson<unknown[]>(
      this.runner,
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        branch,
        "--state",
        state,
        "--json",
        PR_JSON_FIELDS,
        "--limit",
        "1",
      ],
      { cwd: this.cwd }
    );
    return prs[0] ? normalizePullRequest(prs[0]) : undefined;
  }

  async listOpenPullRequests(repo: string): Promise<PullRequest[]> {
    const raw = await runJson<unknown[]>(
      this.runner,
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        PR_JSON_FIELDS,
        "--limit",
        "1000",
      ],
      { cwd: this.cwd }
    );
    return raw.map(normalizePullRequest);
  }

  async getPullRequest(repo: string, pullNumber: number): Promise<PullRequest> {
    const raw = await runJson<unknown>(
      this.runner,
      "gh",
      [
        "pr",
        "view",
        String(pullNumber),
        "--repo",
        repo,
        "--json",
        PR_JSON_FIELDS,
      ],
      { cwd: this.cwd }
    );
    return normalizePullRequest(raw);
  }

  async createOrUpdatePullRequest(
    input: CreateOrUpdatePrInput
  ): Promise<PullRequest> {
    const existing = await this.getPullRequestByBranch(
      input.repo,
      input.headBranch,
      "open"
    );
    const bodyFile = `/tmp/agent-train-pr-${crypto.randomUUID()}.md`;
    await writeText(bodyFile, input.body);

    try {
      if (existing) {
        await mustRun(
          this.runner,
          "gh",
          [
            "pr",
            "edit",
            String(existing.number),
            "--repo",
            input.repo,
            "--base",
            input.baseBranch,
            "--title",
            input.title,
            "--body-file",
            bodyFile,
          ],
          { cwd: this.cwd }
        );
        return this.getPullRequest(input.repo, existing.number);
      }

      await mustRun(
        this.runner,
        "gh",
        [
          "pr",
          "create",
          "--repo",
          input.repo,
          "--base",
          input.baseBranch,
          "--head",
          input.headBranch,
          "--title",
          input.title,
          "--body-file",
          bodyFile,
        ],
        { cwd: this.cwd }
      );

      const created = await this.getPullRequestByBranch(
        input.repo,
        input.headBranch,
        "open"
      );
      if (!created) {
        throw new Error(
          `Created PR for ${input.headBranch}, but gh could not find it afterward.`
        );
      }
      return created;
    } finally {
      await this.runner.run("rm", ["-f", bodyFile]);
    }
  }

  async editPullRequestBase(
    repo: string,
    pullNumber: number,
    baseBranch: string
  ): Promise<void> {
    await mustRun(
      this.runner,
      "gh",
      ["pr", "edit", String(pullNumber), "--repo", repo, "--base", baseBranch],
      { cwd: this.cwd }
    );
  }

  async getPullRequestDiff(repo: string, pullNumber: number): Promise<string> {
    const result = await mustRun(
      this.runner,
      "gh",
      ["pr", "diff", String(pullNumber), "--repo", repo],
      { cwd: this.cwd }
    );
    return result.stdout;
  }

  async createPullRequestReview(input: PullRequestReviewInput): Promise<void> {
    const route = `/repos/${input.repo}/pulls/${input.pullNumber}/reviews`;
    await mustRun(
      this.runner,
      "gh",
      ["api", "--method", "POST", route, "--input", "-"],
      {
        cwd: this.cwd,
        input: JSON.stringify({
          commit_id: input.commitId,
          event: input.event,
          body: input.body,
          comments: input.comments,
        }),
      }
    );
  }

  async mergePullRequest(
    repo: string,
    pullNumber: number,
    headSha: string,
    method: "squash" | "merge" | "rebase" = "squash"
  ): Promise<void> {
    const methodFlag =
      method === "squash"
        ? "--squash"
        : method === "merge"
          ? "--merge"
          : "--rebase";
    await mustRun(
      this.runner,
      "gh",
      [
        "pr",
        "merge",
        String(pullNumber),
        "--repo",
        repo,
        methodFlag,
        "--auto",
        "--match-head-commit",
        headSha,
      ],
      { cwd: this.cwd }
    );
  }

  async waitForPullRequestMerged(
    repo: string,
    pullNumber: number,
    timeoutMs = 15 * 60 * 1000,
    intervalMs = 15_000
  ): Promise<PullRequest> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const pr = await this.getPullRequest(repo, pullNumber);
      if (pr.state === "MERGED") return pr;
      if (pr.state === "CLOSED") {
        throw new Error(
          `PR #${pullNumber} closed without reporting MERGED state.`
        );
      }
      await Bun.sleep(intervalMs);
    }

    throw new Error(`Timed out waiting for PR #${pullNumber} to merge.`);
  }
}

export function isPullRequestGreen(
  pr: PullRequest
): { ok: true } | { ok: false; reason: string } {
  if (pr.isDraft)
    return { ok: false, reason: `PR #${pr.number} is still a draft.` };
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { ok: false, reason: `PR #${pr.number} has requested changes.` };
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return {
      ok: false,
      reason: `PR #${pr.number} is still waiting for required review approval.`,
    };
  }

  const mergeState = pr.mergeStateStatus?.toUpperCase();
  if (
    mergeState &&
    ["BEHIND", "BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"].includes(mergeState)
  ) {
    return {
      ok: false,
      reason: `PR #${pr.number} is not mergeable yet (${mergeState}).`,
    };
  }

  const checks = pr.statusCheckRollup ?? [];
  const failing = checks.filter((check) => {
    if (typeof check !== "object" || check === null) return false;
    const value = check as Record<string, unknown>;
    const conclusion = String(
      value.conclusion ?? value.state ?? value.status ?? ""
    ).toUpperCase();
    return !["", "SUCCESS", "SKIPPED", "NEUTRAL", "COMPLETED"].includes(
      conclusion
    );
  });

  if (failing.length > 0) {
    return {
      ok: false,
      reason: `PR #${pr.number} has ${failing.length} non-green status check(s).`,
    };
  }

  return { ok: true };
}

export function reviewFindingBody(finding: ReviewFinding): string {
  return [`**${finding.axis}: ${finding.title}**`, "", finding.body].join("\n");
}

function normalizeIssue(raw: unknown): Issue {
  const value = objectRecord(raw, "issue");
  return {
    number: numberField(value, "number"),
    title: stringField(value, "title"),
    body: typeof value.body === "string" ? value.body : "",
    state: normalizeIssueState(value.state),
    url: typeof value.url === "string" ? value.url : "",
    labels: normalizeLabels(value.labels),
    blockedBy: normalizeRefs(value.blockedBy),
    blocking: normalizeRefs(value.blocking),
    parent: normalizeRefs(value.parent)[0],
    subIssues: normalizeRefs(value.subIssues),
  };
}

function normalizePullRequest(raw: unknown): PullRequest {
  const value = objectRecord(raw, "pull request");
  return {
    number: numberField(value, "number"),
    url: stringField(value, "url"),
    title: stringField(value, "title"),
    body: typeof value.body === "string" ? value.body : "",
    state: stringField(value, "state"),
    isDraft: Boolean(value.isDraft),
    headRefName: stringField(value, "headRefName"),
    baseRefName: stringField(value, "baseRefName"),
    baseRefOid: typeof value.baseRefOid === "string" ? value.baseRefOid : "",
    headRefOid: stringField(value, "headRefOid"),
    mergeStateStatus:
      typeof value.mergeStateStatus === "string"
        ? value.mergeStateStatus
        : undefined,
    reviewDecision:
      typeof value.reviewDecision === "string"
        ? value.reviewDecision
        : undefined,
    statusCheckRollup: Array.isArray(value.statusCheckRollup)
      ? value.statusCheckRollup
      : [],
    closingIssuesReferences: normalizeRefs(value.closingIssuesReferences),
    latestReviews: normalizeLatestReviews(value.latestReviews),
  };
}

function normalizeLatestReviews(value: unknown): PullRequestReviewSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): PullRequestReviewSummary | undefined => {
      if (typeof item !== "object" || item === null) return undefined;
      const record = item as Record<string, unknown>;
      return {
        state: String(record.state ?? ""),
        body: typeof record.body === "string" ? record.body : "",
        submittedAt:
          typeof record.submittedAt === "string"
            ? record.submittedAt
            : undefined,
        authorLogin: normalizeAuthorLogin(record.author),
      };
    })
    .filter((review): review is PullRequestReviewSummary => Boolean(review));
}

function normalizeAuthorLogin(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const login = (value as { login?: unknown }).login;
  return typeof login === "string" ? login : undefined;
}

function normalizeIssueSummary(raw: unknown): GitHubIssueSummary {
  const value = objectRecord(raw, "issue summary");
  return {
    number: numberField(value, "number"),
    title: stringField(value, "title"),
    url: stringField(value, "url"),
    state: stringField(value, "state"),
  };
}

function normalizeIssueState(value: unknown): "OPEN" | "CLOSED" {
  const state = String(value ?? "OPEN").toUpperCase();
  return state === "CLOSED" ? "CLOSED" : "OPEN";
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === "string") return label;
      if (
        typeof label === "object" &&
        label !== null &&
        typeof (label as { name?: unknown }).name === "string"
      ) {
        return (label as { name: string }).name;
      }
      return undefined;
    })
    .filter((label): label is string => Boolean(label));
}

function normalizeRefs(value: unknown): IssueRef[] {
  if (!value) return [];

  const values = Array.isArray(value)
    ? value
    : typeof value === "object" &&
        value !== null &&
        Array.isArray((value as { nodes?: unknown }).nodes)
      ? (value as { nodes: unknown[] }).nodes
      : typeof value === "object" && value !== null && "number" in value
        ? [value]
        : [];

  return values
    .map((item): IssueRef | undefined => {
      if (typeof item !== "object" || item === null) return undefined;
      const record = item as Record<string, unknown>;
      if (typeof record.number !== "number") return undefined;
      return {
        number: record.number,
        title: typeof record.title === "string" ? record.title : undefined,
        state:
          record.state === "CLOSED"
            ? "CLOSED"
            : record.state === "OPEN"
              ? "OPEN"
              : undefined,
        url: typeof record.url === "string" ? record.url : undefined,
      };
    })
    .filter((ref): ref is IssueRef => Boolean(ref));
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Expected ${label} JSON object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== "string") {
    throw new Error(`Expected string field "${field}".`);
  }
  return value[field] as string;
}

function numberField(value: Record<string, unknown>, field: string): number {
  if (typeof value[field] !== "number") {
    throw new Error(`Expected number field "${field}".`);
  }
  return value[field] as number;
}

function enrichDependencyFieldError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("blockedBy") ||
    message.includes("blocking") ||
    message.includes("subIssues")
  ) {
    return new Error(
      `${message}\nGitHub native issue dependency fields are required. Upgrade gh to 2.94+ and confirm this repository exposes issue dependencies.`
    );
  }
  return error instanceof Error ? error : new Error(message);
}
