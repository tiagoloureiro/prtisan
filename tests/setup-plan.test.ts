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
});
