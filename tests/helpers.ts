import type { CommandOptions, CommandResult, CommandRunner } from "@/exec.js";
import type { AgentTrainConfig, Issue, PullRequest } from "@/types.js";

export function testConfig(
  input: Partial<AgentTrainConfig> = {}
): AgentTrainConfig {
  return {
    repo: "o/r",
    targetBranch: "main",
    remote: "origin",
    models: {
      repair: "gpt-5.6-terra",
      review: "gpt-5.6-luna",
    },
    reasoning: {
      repair: "medium",
      review: "low",
    },
    concurrency: {
      validate: 4,
      github: 4,
    },
    docker: {
      imageName: "sandcastle:agent-train",
      codexHome: ".sandcastle/codex-home",
      mounts: [],
    },
    retention: {
      ttlDays: 14,
      maxLogBytes: 10 * 1024 * 1024,
      keepSessions: true,
    },
    ...input,
  };
}

export function issue(
  input: Partial<Issue> & Pick<Issue, "number" | "title">
): Issue {
  return {
    body: "",
    state: "OPEN",
    url: `https://github.com/o/r/issues/${input.number}`,
    labels: [],
    blockedBy: [],
    blocking: [],
    subIssues: [],
    ...input,
  };
}

export function pullRequest(input: Partial<PullRequest>): PullRequest {
  const number = input.number ?? 1;
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `PR ${number}`,
    body: "",
    state: "OPEN",
    isDraft: false,
    headRefName: `branch-${number}`,
    baseRefName: "main",
    baseRefOid: "base-sha",
    headRefOid: `head-${number}`,
    closingIssuesReferences: [],
    latestReviews: [],
    statusCheckRollup: [],
    ...input,
  };
}

export class FakeRunner implements CommandRunner {
  readonly calls: {
    readonly command: string;
    readonly args: readonly string[];
    readonly options?: CommandOptions;
  }[] = [];
  private responses: CommandResult[] = [];

  enqueue(stdout: string, exitCode = 0, stderr = ""): void {
    this.responses.push({
      command: [],
      stdout,
      stderr,
      exitCode,
    });
  }

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    const response = this.responses.shift() ?? {
      command: [command, ...args],
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
    return {
      ...response,
      command: [command, ...args],
      cwd: options?.cwd,
    };
  }
}
