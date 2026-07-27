import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { pathExists, readJson, readText } from "@/fs.js";
import { prtisanRepositoryDataPath } from "@/prtisan-paths.js";
import { appendRunEvent, writeRunRecord } from "@/run-record.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

test("records running state and an append-only event timeline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "prtisan-run-record-test-"));
  temporaryDirectories.push(cwd);
  const runId = "merge-20260726-fixture";
  await writeRunRecord(cwd, {
    schemaVersion: 2,
    runId,
    command: "merge",
    repo: "o/r",
    startedAt: "2026-07-26T00:00:00.000Z",
    status: "running",
  });
  await appendRunEvent(cwd, runId, {
    at: "2026-07-26T00:00:01.000Z",
    type: "stage",
    message: "Validating PR #1",
    data: { pullNumber: 1, headRefOid: "abc" },
  });

  const recordPath = join(
    prtisanRepositoryDataPath(cwd, "legacy-runs", runId),
    "run.json"
  );
  expect(await readJson(recordPath)).toMatchObject({
    schemaVersion: 2,
    status: "running",
  });
  expect(await pathExists(`${recordPath}.${process.pid}.temporary`)).toBe(
    false
  );
  const events = await readText(
    join(prtisanRepositoryDataPath(cwd, "legacy-runs", runId), "events.jsonl")
  );
  expect(JSON.parse(events.trim())).toMatchObject({
    type: "stage",
    message: "Validating PR #1",
    data: { pullNumber: 1 },
  });
});
