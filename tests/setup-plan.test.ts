import { describe, expect, test } from "bun:test";

import { createSetupPlan } from "@/setup-plan.js";

import { FakeRunner } from "./helpers.js";

describe("setup planning", () => {
  test("freezes repository identity and target head without writing files", async () => {
    const runner = new FakeRunner();
    runner.enqueue("/repo\n");
    runner.enqueue(
      JSON.stringify({
        nameWithOwner: "o/r",
        defaultBranchRef: { name: "main" },
      })
    );
    runner.enqueue("");
    runner.enqueue("base-sha\n");

    const plan = await createSetupPlan({
      cwd: "/repo/subdir",
      runner,
      now: new Date("2026-07-27T00:00:00.000Z"),
    });

    expect(plan).toMatchObject({
      kind: "setup",
      cwd: "/repo",
      repo: "o/r",
      targetBranch: "main",
      targetHead: "base-sha",
      branch: "prtisan/setup",
    });
    expect(plan.id).toMatch(/^setup-[a-f0-9]{16}$/);
    expect(runner.calls.every((call) => call.command !== "mkdir")).toBe(true);
  });

  test("turns a valid v1 manifest into a reviewed setup upgrade", async () => {
    const runner = new FakeRunner();
    runner.enqueue("/repo\n");
    runner.enqueue(
      JSON.stringify({
        nameWithOwner: "o/r",
        defaultBranchRef: { name: "main" },
      })
    );
    runner.enqueue("");
    runner.enqueue("base-sha\n");
    runner.enqueue(
      JSON.stringify({
        schemaVersion: 1,
        targetBranch: "main",
        sandbox: {
          provider: "docker",
          dockerfile: ".prtisan/Dockerfile",
          context: ".",
          imageName: "custom:repository",
          cpus: 3,
        },
        verification: {
          commands: [{ name: "test", command: "bun test", timeoutMs: 120_000 }],
        },
        contract: { prBodySections: ["Why"] },
        codex: {
          reviewModel: "legacy-review",
          repairModel: "legacy-repair",
          reviewEffort: "low",
          repairEffort: "high",
        },
        limits: {
          readConcurrency: 2,
          githubConcurrency: 4,
          maxRepairCandidates: 3,
          maxCandidatesPerCause: 2,
          applyLeaseTtlMs: 90_000,
        },
      })
    );

    const plan = await createSetupPlan({
      cwd: "/repo",
      runner,
      now: new Date("2026-07-27T00:00:00.000Z"),
    });

    expect(plan.upgrade).toBe(true);
    expect(plan.proposedManifest).toMatchObject({
      schemaVersion: 2,
      sandbox: { imageName: "custom:repository", cpus: 3 },
      verification: { commands: [{ command: "bun test" }] },
      contract: { prBodySections: ["Why"] },
    });
    expect(Object.keys(plan.proposedManifest.codex.roles)).toHaveLength(7);
  });
});
