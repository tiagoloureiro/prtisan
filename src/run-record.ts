import { chmod } from "node:fs/promises";

import { writeJson } from "./fs.js";
import { joinPath } from "./path.js";

export interface RunRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly command: "validate" | "merge";
  readonly repo: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "completed" | "failed";
  readonly result?: unknown;
  readonly error?: string;
}

export async function writeRunRecord(
  cwd: string,
  record: RunRecord
): Promise<void> {
  const path = joinPath(cwd, ".sandcastle", "runs", record.runId, "run.json");
  await writeJson(path, record);
  await chmod(path, 0o600);
}
