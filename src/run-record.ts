import { appendFile, chmod, rename } from "node:fs/promises";

import { ensureDir, writeJson } from "./fs.js";
import { joinPath } from "./path.js";
import { prtisanRepositoryDataPath } from "./prtisan-paths.js";

export interface RunRecord {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly command: "validate" | "merge";
  readonly repo: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: "running" | "completed" | "failed";
  readonly result?: unknown;
  readonly error?: string;
}

export async function writeRunRecord(
  cwd: string,
  record: RunRecord
): Promise<void> {
  const path = joinPath(
    prtisanRepositoryDataPath(cwd, "legacy-runs", record.runId),
    "run.json"
  );
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeJson(temporaryPath, record);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export interface RunEvent {
  readonly at: string;
  readonly type:
    | "command_started"
    | "command_completed"
    | "command_failed"
    | "stage"
    | "agent"
    | "verification"
    | "git"
    | "github";
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export async function appendRunEvent(
  cwd: string,
  runId: string,
  event: Omit<RunEvent, "at"> & { readonly at?: string }
): Promise<void> {
  const directory = prtisanRepositoryDataPath(cwd, "legacy-runs", runId);
  const path = joinPath(directory, "events.jsonl");
  await ensureDir(directory);
  await appendFile(
    path,
    `${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );
  await chmod(path, 0o600);
}
