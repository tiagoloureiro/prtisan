import { describe, expect, test } from "bun:test";

import type { CommandOptions, CommandResult, CommandRunner } from "@/exec.js";
import { defaultManifest } from "@/manifest.js";
import { InMemoryArtifactStore } from "@/workflow/artifacts.js";
import { InMemoryWorkflowJournal } from "@/workflow/journal.js";
import { ProductionWorkflowEnvironment } from "@/workflow/production.js";
import { PrtisanWorkflow } from "@/workflow/workflow.js";

import { pullRequest } from "./helpers.js";

describe("production workflow", () => {
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
});

class HistoricalBaseRunner implements CommandRunner {
  constructor(private manifest: string) {}

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
