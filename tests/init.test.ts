import { describe, expect, test } from "bun:test";

import { executeInit } from "@/commands/init.js";
import type { CommandOptions, CommandResult } from "@/exec.js";
import { readText } from "@/fs.js";
import { GitHubClient } from "@/github.js";

import { FakeRunner } from "./helpers.js";

describe("init command", () => {
  test("writes files locally when cwd is not a git repo", async () => {
    const cwd = `/tmp/agent-train-init-local-${crypto.randomUUID()}`;
    const runner = new FakeRunner();
    runner.enqueue("", 1, "not a git repository");

    const result = await executeInit(
      {
        cwd,
        repo: "o/r",
      },
      {
        runner,
        github: {} as GitHubClient,
      }
    );

    expect(result.mode).toBe("local");
    expect(result.reason).toContain("No git repository");
    expect(
      await readText(`${cwd}/.sandcastle/agent-train.config.json`)
    ).toContain('"repo": "o/r"');
  });

  test("creates issue and PR through GitHub for a GitHub git repo", async () => {
    const cwd = `/tmp/agent-train-init-github-${crypto.randomUUID()}`;
    const runner = new BodyCaptureRunner();
    runner.enqueue(`${cwd}\n`);
    runner.enqueue(
      JSON.stringify({
        nameWithOwner: "o/r",
        defaultBranchRef: { name: "main" },
      })
    );
    runner.enqueue("gh version 2.95.0 (2026-06-17)\n");
    runner.enqueue("");
    runner.enqueue("", 1);
    runner.enqueue("");
    runner.enqueue("");
    runner.enqueue(" M .gitignore\n?? .sandcastle/\n");
    runner.enqueue("");
    runner.enqueue("");
    runner.enqueue("");
    runner.enqueue("[]");
    runner.enqueue("https://github.com/o/r/issues/7\n");
    runner.enqueue("");
    runner.enqueue("[]");
    runner.enqueue("");
    runner.enqueue(
      JSON.stringify([
        {
          number: 8,
          url: "https://github.com/o/r/pull/8",
          title: "Configure Agent PR Train",
          state: "OPEN",
          isDraft: false,
          headRefName: "agent-train/setup",
          baseRefName: "main",
          headRefOid: "sha",
          statusCheckRollup: [],
        },
      ])
    );

    const result = await executeInit(
      {
        cwd,
      },
      {
        runner,
        github: new GitHubClient(runner, cwd),
      }
    );

    expect(result.mode).toBe("github");
    expect(result.issue?.number).toBe(7);
    expect(result.pr?.number).toBe(8);
    expect(
      runner.calls.some(
        (call) => call.command === "git" && call.args[0] === "push"
      )
    ).toBe(true);
    expect(
      runner.calls.some(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "issue" &&
          call.args[1] === "create"
      )
    ).toBe(true);
    expect(
      runner.calls.some(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "pr" &&
          call.args[1] === "create"
      )
    ).toBe(true);
    expect(runner.issueBody).toContain("<!-- agent-train:init -->");
    expect(runner.issueBody).toContain("## Canonical Documentation");
    expect(runner.issueBody).toContain(
      "https://tiagoloureiro.github.io/prtisan/"
    );
    expect(runner.issueBody).toContain(
      "https://github.com/tiagoloureiro/prtisan/blob/main/docs/index.md"
    );
    expect(runner.issueBody).toContain(
      "https://raw.githubusercontent.com/tiagoloureiro/prtisan/main/docs/index.md"
    );
    expect(runner.issueBody).toContain("## Required Local Tools And Access");
    expect(runner.issueBody).toContain("## After Merge Checklist");
    expect(runner.issueBody).toContain(
      "- `.sandcastle/agent-train.config.json`: created"
    );
    expect(runner.pullRequestBody).toContain(
      "https://tiagoloureiro.github.io/prtisan/"
    );
    expect(runner.pullRequestBody).toContain(
      "Raw Markdown for agents: https://raw.githubusercontent.com/tiagoloureiro/prtisan/main/docs/index.md"
    );
  });

  test("rebuilds an existing setup branch from target before opening the PR", async () => {
    const cwd = `/tmp/agent-train-init-existing-branch-${crypto.randomUUID()}`;
    const runner = new ExistingSetupBranchRunner(
      cwd,
      " M .gitignore\n?? .sandcastle/\n"
    );

    await executeInit(
      {
        cwd,
      },
      {
        runner,
        github: new GitHubClient(runner, cwd),
      }
    );

    const worktreeAdd = runner.calls.find(
      (call) =>
        call.command === "git" &&
        call.args[0] === "worktree" &&
        call.args[1] === "add"
    );
    const targetFetchIndex = runner.calls.findIndex(
      (call) =>
        call.command === "git" &&
        call.args[0] === "fetch" &&
        call.args[2] === "refs/heads/main:refs/remotes/origin/main"
    );
    const pushIndex = runner.calls.findIndex(
      (call) => call.command === "git" && call.args[0] === "push"
    );
    const prCreateIndex = runner.calls.findIndex(
      (call) =>
        call.command === "gh" &&
        call.args[0] === "pr" &&
        call.args[1] === "create"
    );

    expect(worktreeAdd?.args.at(-1)).toBe("origin/main");
    expect(targetFetchIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(targetFetchIndex);
    expect(prCreateIndex).toBeGreaterThan(pushIndex);
  });

  test("does not open a stale setup PR when target already has the scaffold", async () => {
    const cwd = `/tmp/agent-train-init-stale-branch-${crypto.randomUUID()}`;
    const runner = new ExistingSetupBranchRunner(cwd, "");

    const result = await executeInit(
      {
        cwd,
      },
      {
        runner,
        github: new GitHubClient(runner, cwd),
      }
    );

    expect(result.pr).toBeUndefined();
    expect(result.reason).toContain("no setup PR was needed");
    expect(
      runner.calls.some(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "pr" &&
          call.args[1] === "create"
      )
    ).toBe(false);
  });
});

class BodyCaptureRunner extends FakeRunner {
  issueBody = "";
  pullRequestBody = "";

  override async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    await this.captureBody(command, args);
    return super.run(command, args, options);
  }

  private async captureBody(
    command: string,
    args: readonly string[]
  ): Promise<void> {
    if (command !== "gh") return;

    const bodyFileIndex = args.indexOf("--body-file");
    const bodyFile = args[bodyFileIndex + 1];
    if (bodyFileIndex === -1 || !bodyFile) return;

    if (args[0] === "issue" && args[1] === "create") {
      this.issueBody = await readText(bodyFile);
    } else if (args[0] === "pr" && ["create", "edit"].includes(args[1] ?? "")) {
      this.pullRequestBody = await readText(bodyFile);
    }
  }
}

class ExistingSetupBranchRunner extends FakeRunner {
  private prCreated = false;

  constructor(
    private readonly root: string,
    private readonly statusOutput: string
  ) {
    super();
  }

  override async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    this.calls.push({ command, args, options });

    if (command === "git" && args[0] === "rev-parse") {
      return this.result(command, args, options, `${this.root}\n`);
    }
    if (command === "gh" && args[0] === "repo") {
      return this.result(
        command,
        args,
        options,
        JSON.stringify({
          nameWithOwner: "o/r",
          defaultBranchRef: { name: "main" },
        })
      );
    }
    if (command === "gh" && args[0] === "--version") {
      return this.result(command, args, options, "gh version 2.95.0\n");
    }
    if (command === "git" && args[0] === "ls-remote") {
      return this.result(command, args, options, "");
    }
    if (command === "git" && args[0] === "status") {
      return this.result(command, args, options, this.statusOutput);
    }
    if (command === "gh" && args[0] === "issue" && args[1] === "list") {
      return this.result(command, args, options, existingSetupIssueJson());
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return this.result(
        command,
        args,
        options,
        this.prCreated ? setupPullRequestJson() : "[]"
      );
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      this.prCreated = true;
    }

    return this.result(command, args, options, "");
  }

  private result(
    command: string,
    args: readonly string[],
    options: CommandOptions | undefined,
    stdout: string,
    exitCode = 0,
    stderr = ""
  ): CommandResult {
    return {
      command: [command, ...args],
      cwd: options?.cwd,
      stdout,
      stderr,
      exitCode,
    };
  }
}

function existingSetupIssueJson(): string {
  return JSON.stringify([
    {
      number: 7,
      title: "Configure Agent PR Train",
      url: "https://github.com/o/r/issues/7",
      state: "OPEN",
    },
  ]);
}

function setupPullRequestJson(): string {
  return JSON.stringify([
    {
      number: 8,
      url: "https://github.com/o/r/pull/8",
      title: "Configure Agent PR Train",
      state: "OPEN",
      isDraft: false,
      headRefName: "agent-train/setup",
      baseRefName: "main",
      headRefOid: "sha",
      statusCheckRollup: [],
    },
  ]);
}
