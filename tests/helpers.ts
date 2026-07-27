import { writeFile } from "node:fs/promises";

import { defaultConfig } from "@/config.js";
import type { CommandOptions, CommandResult, CommandRunner } from "@/exec.js";
import type {
  AgentRoleProfiles,
  AgentTrainConfig,
  Issue,
  PullRequest,
} from "@/types.js";

export const QUALITY_FIRST_AGENT_PROFILES: AgentRoleProfiles = {
  standardsReview: {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  },
  specReview: {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  },
  repairVerification: {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  },
  validationRepair: {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  },
  ciRepair: {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  },
  mergeStateRepair: {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  },
  restackConflictRepair: {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  },
};

export function testConfig(
  input: Partial<AgentTrainConfig> = {}
): AgentTrainConfig {
  const defaults = defaultConfig({
    repo: input.repo ?? "o/r",
    targetBranch: input.targetBranch ?? "main",
  });

  return {
    ...defaults,
    ...input,
    agentProfiles: {
      ...defaults.agentProfiles,
      ...input.agentProfiles,
    },
    concurrency: {
      ...defaults.concurrency,
      ...input.concurrency,
    },
    docker: {
      ...defaults.docker,
      ...input.docker,
      mounts: input.docker?.mounts ?? defaults.docker.mounts,
    },
    retention: {
      ...defaults.retention,
      ...input.retention,
    },
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
    reviews: [],
    comments: [],
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
    if (
      command === "docker" &&
      args[0] === "build" &&
      response.exitCode === 0
    ) {
      const iidFile = args[args.indexOf("--iidfile") + 1];
      const imageId = response.stdout.trim();
      if (iidFile && /^sha256:[a-f0-9]{64}$/.test(imageId)) {
        await writeFile(iidFile, `${imageId}\n`);
      }
    }
    return {
      ...response,
      command: [command, ...args],
      cwd: options?.cwd,
    };
  }
}
