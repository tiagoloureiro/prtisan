import { readdir } from "node:fs/promises";

import { pathExists, readJson, readText } from "./fs.js";
import { joinPath } from "./path.js";
import { prtisanRepositoryDataPath } from "./prtisan-paths.js";

export async function listRuns(cwd: string): Promise<unknown[]> {
  const root = prtisanRepositoryDataPath(cwd, "legacy-runs");
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = joinPath(root, entry.name, "run.json");
        if (!(await pathExists(path))) {
          return { runId: entry.name, status: "unknown" };
        }
        try {
          return await readJson<Record<string, unknown>>(path);
        } catch (error) {
          return {
            runId: entry.name,
            status: "invalid",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
  );
  return records.sort((left, right) =>
    String(right.startedAt ?? right.runId).localeCompare(
      String(left.startedAt ?? left.runId)
    )
  );
}

export async function showRun(cwd: string, runId: string): Promise<unknown> {
  if (!/^(?:merge|validate)-[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
  const root = prtisanRepositoryDataPath(cwd, "legacy-runs", runId);
  const recordPath = joinPath(root, "run.json");
  if (!(await pathExists(recordPath))) {
    throw new Error(`Run ${runId} has no run.json record.`);
  }
  const record = await readJson<Record<string, unknown>>(recordPath);
  const eventsPath = joinPath(root, "events.jsonl");
  const events = (await pathExists(eventsPath))
    ? (await readText(eventsPath))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return { type: "invalid", raw: line };
          }
        })
    : [];
  return { ...record, events };
}
