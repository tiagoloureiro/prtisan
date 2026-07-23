import type { GitHubClient } from "./github.js";
import type { Issue } from "./types.js";

export class GitHubIssueContext {
  private readonly issues = new Map<number, Promise<Issue>>();

  constructor(
    private readonly github: GitHubClient,
    private readonly repo: string
  ) {}

  remember(issue: Issue): void {
    this.issues.set(issue.number, Promise.resolve(issue));
  }

  rememberAll(issues: readonly Issue[]): void {
    for (const issue of issues) {
      this.remember(issue);
    }
  }

  get(issueNumber: number): Promise<Issue> {
    const cached = this.issues.get(issueNumber);
    if (cached) return cached;
    const promise = this.github.getIssue(this.repo, issueNumber);
    this.issues.set(issueNumber, promise);
    return promise;
  }

  relatedIssues(issue: Issue): Promise<Issue[]> {
    return Promise.all(
      relatedIssueNumbers(issue).map((issueNumber) => this.get(issueNumber))
    );
  }
}

export function relatedIssueNumbers(issue: Issue): number[] {
  const numbers = new Set<number>();
  for (const ref of [
    ...issue.blockedBy,
    ...issue.blocking,
    ...issue.subIssues,
  ]) {
    numbers.add(ref.number);
  }
  if (issue.parent) numbers.add(issue.parent.number);
  numbers.delete(issue.number);
  return [...numbers].sort((a, b) => a - b);
}
