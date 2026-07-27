import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";

import { SqliteWorkflowJournal } from "@/workflow/journal.js";
import type { TrainPlan } from "@/workflow/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("SQLite workflow journal", () => {
  test("replays events, deduplicates effects, and reclaims expired leases", async () => {
    const root = `/tmp/prtisan-journal-${crypto.randomUUID()}`;
    roots.push(root);
    const journal = await SqliteWorkflowJournal.open(`${root}/journal.sqlite`);
    const plan = testPlan();
    await journal.savePlan(plan, {
      type: "plan_created",
      at: plan.createdAt,
      planId: plan.id,
      repositoryKey: plan.repositoryKey,
      pullRequests: [],
    });
    await journal.append(plan.id, {
      type: "apply_started",
      at: "2026-07-27T00:01:00.000Z",
    });
    await journal.startEffect(plan.id, "merge:1:head", plan.createdAt);
    await journal.completeEffect(
      plan.id,
      "merge:1:head",
      { state: "MERGED" },
      plan.createdAt
    );

    expect((await journal.snapshot(plan.id))?.outcome).toBe("running");
    expect(await journal.effect(plan.id, "merge:1:head")).toMatchObject({
      status: "completed",
      result: { state: "MERGED" },
    });

    const first = await journal.acquire("repo", "one", 1_000, 100);
    await expect(journal.acquire("repo", "two", 1_050, 100)).rejects.toThrow(
      "Another prtisan apply"
    );
    const reclaimed = await journal.acquire("repo", "two", 1_101, 100);
    await reclaimed.release();
    await first.release();
    journal.close();
  });
});

function testPlan(): TrainPlan {
  return {
    schemaVersion: 1,
    id: "plan-test",
    repositoryKey: "repo",
    cwd: "/repo",
    repo: "o/r",
    targetBranch: "main",
    createdAt: "2026-07-27T00:00:00.000Z",
    manifestDigest: "manifest",
    manifest: {},
    pullRequests: [],
    topologicalOrder: [],
    planDigest: "digest",
  };
}
