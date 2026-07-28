import { describe, expect, test } from "bun:test";

import { AgentInfrastructureError } from "@/agent.js";
import {
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  CommandSpawnError,
} from "@/exec.js";
import { defaultManifest } from "@/manifest.js";
import { InMemoryArtifactStore } from "@/workflow/artifacts.js";
import { InMemoryWorkflowJournal } from "@/workflow/journal.js";
import {
  classifyPreparationError,
  ProductionWorkflowEnvironment,
} from "@/workflow/production.js";
import type { TrainPlan } from "@/workflow/types.js";
import { PrtisanWorkflow, SetupRequiredError } from "@/workflow/workflow.js";

import { pullRequest } from "./helpers.js";

describe("production workflow", () => {
  test("requires reviewed setup when the target uses the legacy managed runtime", async () => {
    const manifest = defaultManifest({
      bootstrap: {
        name: "Install",
        command: "pnpm install --frozen-lockfile",
        timeoutMs: 60_000,
      },
      commands: [{ name: "Check", command: "pnpm check", timeoutMs: 60_000 }],
    });
    const runner = new HistoricalBaseRunner(
      JSON.stringify(manifest),
      [
        "FROM oven/bun:1.2.22-debian",
        "ENV BUN_INSTALL=/usr/local/share/bun",
        "RUN bun add --global @openai/codex@0.145.0",
        "ENV CODEX_HOME=/home/agent/.codex-prtisan",
      ].join("\n")
    );
    const environment = new ProductionWorkflowEnvironment(runner);

    await expect(environment.inspect({ cwd: "/repo" })).rejects.toBeInstanceOf(
      SetupRequiredError
    );
  });

  test("plans an existing stack whose base commits predate repository setup", async () => {
    const manifest = defaultManifest({
      commands: [{ name: "Check", command: "bun test", timeoutMs: 60_000 }],
    });
    const runner = new HistoricalBaseRunner(JSON.stringify(manifest));
    const workflow = new PrtisanWorkflow(
      new InMemoryWorkflowJournal(),
      new InMemoryArtifactStore(),
      new ProductionWorkflowEnvironment(runner)
    );

    const plan = await workflow.plan({ cwd: "/repo" });

    expect(plan.topologicalOrder).toEqual([1, 2]);
    expect(plan.pullRequests.map((pr) => pr.manifestDigest)).toEqual([
      plan.manifestDigest,
      plan.manifestDigest,
    ]);
    expect(plan.pullRequests.map((pr) => pr.manifest)).toEqual([
      plan.manifest,
      plan.manifest,
    ]);
  });

  test("marks a plan stale when reviewed target policy changes", async () => {
    const manifest = defaultManifest({
      commands: [{ name: "Check", command: "bun test", timeoutMs: 60_000 }],
    });
    const runner = new HistoricalBaseRunner(JSON.stringify(manifest));
    const environment = new ProductionWorkflowEnvironment(runner);
    const workflow = new PrtisanWorkflow(
      new InMemoryWorkflowJournal(),
      new InMemoryArtifactStore(),
      environment
    );
    const plan = await workflow.plan({ cwd: "/repo" });
    runner.setManifest(
      JSON.stringify(
        defaultManifest({
          commands: [
            {
              name: "Check",
              command: "bun test --coverage",
              timeoutMs: 60_000,
            },
          ],
        })
      )
    );

    const blocker = await environment.planStaleness(plan);

    expect(blocker).toEqual({
      category: "stale",
      message: "Repository policy on main changed after planning.",
      external: true,
    });
  });

  test("marks legacy plans with mixed per-PR policy stale", async () => {
    const manifest = defaultManifest({
      commands: [{ name: "Check", command: "bun test", timeoutMs: 60_000 }],
    });
    const runner = new HistoricalBaseRunner(JSON.stringify(manifest));
    const environment = new ProductionWorkflowEnvironment(runner);
    const workflow = new PrtisanWorkflow(
      new InMemoryWorkflowJournal(),
      new InMemoryArtifactStore(),
      environment
    );
    const plan = await workflow.plan({ cwd: "/repo" });
    const legacyPlan = {
      ...plan,
      pullRequests: plan.pullRequests.map((pullRequest, index) =>
        index === 0
          ? { ...pullRequest, manifestDigest: "historical-policy-digest" }
          : pullRequest
      ),
    };

    const blocker = await environment.planStaleness(legacyPlan);

    expect(blocker).toEqual({
      category: "stale",
      message:
        "The frozen plan contains inconsistent repository policy and must be replanned.",
      external: true,
    });
  });

  test("classifies authoritative disk exhaustion as a resumable infrastructure gate", () => {
    const classified = classifyPreparationError(
      new AgentInfrastructureError(
        "PR #117 authoritative validation ran out of disk capacity."
      ),
      pullRequest({ number: 117 })
    );

    expect(classified).toEqual({
      kind: "waiting_external",
      blocker: {
        category: "infrastructure",
        message: "PR #117 authoritative validation ran out of disk capacity.",
        external: true,
      },
    });
    expect(classified).not.toHaveProperty("repairCandidates");
  });

  test("recognizes raw pnpm SQLite disk exhaustion as infrastructure", () => {
    const classified = classifyPreparationError(
      new Error(
        "Command failed: pnpm install --frozen-lockfile\nError: database or disk is full"
      ),
      pullRequest({ number: 117 })
    );

    expect(classified).toMatchObject({
      kind: "waiting_external",
      blocker: {
        category: "infrastructure",
        external: true,
      },
    });
  });

  test("adds the cleanup stage to command spawn failures", async () => {
    const environment = new ProductionWorkflowEnvironment({
      run: async () => {
        throw new CommandSpawnError(
          "missing_executable",
          ["git", "worktree", "prune"],
          "/repo"
        );
      },
    });

    await expect(
      environment.cleanup({ cwd: "/repo" } as TrainPlan)
    ).rejects.toThrow(
      "Prtisan worktree reconciliation failed: Cannot start git because the executable is unavailable on PATH."
    );
  });
});

class HistoricalBaseRunner implements CommandRunner {
  constructor(
    private manifest: string,
    private readonly dockerfile = "# custom repository runtime\nFROM scratch\n"
  ) {}

  setManifest(manifest: string): void {
    this.manifest = manifest;
  }

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    if (command === "git" && args[0] === "rev-parse") {
      return result(command, args, options, "/repo\n");
    }
    if (command === "git" && args[0] === "fetch") {
      return result(command, args, options, "");
    }
    if (
      command === "git" &&
      args[0] === "show" &&
      args[1] === "origin/main:.prtisan/manifest.json"
    ) {
      return result(command, args, options, this.manifest);
    }
    if (
      command === "git" &&
      args[0] === "show" &&
      args[1] === "origin/main:.prtisan/Dockerfile"
    ) {
      return result(command, args, options, this.dockerfile);
    }
    if (
      command === "git" &&
      args[0] === "show" &&
      args[1]?.endsWith(":.prtisan/manifest.json")
    ) {
      return result(command, args, options, "", 1, "not found");
    }
    if (command === "git" && args[0] === "ls-tree") {
      return result(command, args, options, "");
    }
    if (command === "gh" && args[0] === "repo" && args[1] === "view") {
      return result(
        command,
        args,
        options,
        JSON.stringify({
          nameWithOwner: "o/r",
          defaultBranchRef: { name: "main" },
        })
      );
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return result(
        command,
        args,
        options,
        JSON.stringify([
          pullRequest({
            number: 1,
            headRefName: "root",
            headRefOid: "root-head",
            baseRefName: "main",
            baseRefOid: "before-setup",
          }),
          pullRequest({
            number: 2,
            headRefName: "child",
            headRefOid: "child-head",
            baseRefName: "root",
            baseRefOid: "root-head",
          }),
        ])
      );
    }
    if (command === "gh" && args[0] === "api") {
      return result(
        command,
        args,
        options,
        JSON.stringify({ contexts: ["Check"] })
      );
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "diff") {
      return result(command, args, options, "");
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  }
}

function result(
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
