import { rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
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
  test("reclaims a fresh lease when its owner process is dead", async () => {
    const root = `/tmp/prtisan-journal-${crypto.randomUUID()}`;
    roots.push(root);
    const journal = await SqliteWorkflowJournal.open(`${root}/journal.sqlite`);
    const acquiredAt = 1_000;
    const ttlMs = 2 * 60 * 60 * 1_000;

    await journal.acquire(
      "repo",
      {
        token: "dead-owner",
        pid: 2_147_483_647,
        createdAt: "2026-07-27T00:00:00.000Z",
      },
      acquiredAt,
      ttlMs
    );

    const replacement = await journal.acquire(
      "repo",
      {
        token: "replacement",
        pid: process.pid,
        createdAt: "2026-07-27T00:00:01.000Z",
      },
      acquiredAt + 1,
      ttlMs
    );
    await replacement.release();
    journal.close();
  });

  test("reclaims a legacy UUID-only lease without manual cleanup", async () => {
    const root = `/tmp/prtisan-journal-${crypto.randomUUID()}`;
    roots.push(root);
    const path = `${root}/journal.sqlite`;
    const initial = await SqliteWorkflowJournal.open(path);
    initial.close();
    const database = new Database(path);
    database
      .query(
        "INSERT INTO leases (repository_key, owner, acquired_at) VALUES (?, ?, ?)"
      )
      .run("repo", "45a9973c-dff8-401b-ae54-88137addd672", 1_000);
    database.close();

    const journal = await SqliteWorkflowJournal.open(path);
    const replacement = await journal.acquire(
      "repo",
      {
        token: "replacement",
        pid: process.pid,
        createdAt: "2026-07-27T00:00:01.000Z",
      },
      1_001,
      2 * 60 * 60 * 1_000
    );
    await replacement.release();
    journal.close();
  });

  test("does not let an old owner release its replacement's lease", async () => {
    const root = `/tmp/prtisan-journal-${crypto.randomUUID()}`;
    roots.push(root);
    const journal = await SqliteWorkflowJournal.open(`${root}/journal.sqlite`);
    const first = await journal.acquire(
      "repo",
      {
        token: "first",
        pid: process.pid,
        createdAt: "2026-07-27T00:00:00.000Z",
      },
      1_000,
      100
    );
    const replacement = await journal.acquire(
      "repo",
      {
        token: "replacement",
        pid: process.pid,
        createdAt: "2026-07-27T00:00:00.101Z",
      },
      1_101,
      100
    );

    await first.release();
    await expect(
      journal.acquire(
        "repo",
        {
          token: "third",
          pid: process.pid,
          createdAt: "2026-07-27T00:00:00.150Z",
        },
        1_150,
        100
      )
    ).rejects.toThrow("Another Prtisan run is active");

    await replacement.release();
    journal.close();
  });

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
    const newerPlan = {
      ...plan,
      id: "plan-newer",
      createdAt: "2026-07-27T00:02:00.000Z",
      planDigest: "newer-digest",
    };
    await journal.savePlan(newerPlan, {
      type: "plan_created",
      at: newerPlan.createdAt,
      planId: newerPlan.id,
      repositoryKey: newerPlan.repositoryKey,
      pullRequests: [],
    });

    expect((await journal.snapshot(plan.id))?.outcome).toBe("running");
    expect((await journal.latestPlan("repo"))?.id).toBe("plan-newer");
    expect(await journal.latestPlan("another-repo")).toBeUndefined();
    expect(await journal.effect(plan.id, "merge:1:head")).toMatchObject({
      status: "completed",
      result: { state: "MERGED" },
    });

    const first = await journal.acquire(
      "repo",
      {
        token: "one",
        pid: process.pid,
        createdAt: "2026-07-27T00:00:00.000Z",
      },
      1_000,
      100
    );
    await expect(
      journal.acquire(
        "repo",
        {
          token: "two",
          pid: process.pid,
          createdAt: "2026-07-27T00:00:00.050Z",
        },
        1_050,
        100
      )
    ).rejects.toThrow("Another Prtisan run is active");
    const reclaimed = await journal.acquire(
      "repo",
      {
        token: "two",
        pid: process.pid,
        createdAt: "2026-07-27T00:00:00.101Z",
      },
      1_101,
      100
    );
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
