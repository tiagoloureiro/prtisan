import { chmod } from "node:fs/promises";
import { Database } from "bun:sqlite";

import { ensureDir } from "@/fs.js";
import { dirname } from "@/path.js";

import { assertPrivacyMinimal } from "./report.js";
import type { EvaluationObservation } from "./types.js";

export interface EvaluationRun {
  readonly id: string;
  readonly corpusDigest: string;
  readonly creditCap: number;
  readonly createdAt: string;
}

export class ModelEvaluationStore {
  private constructor(
    private readonly database: Database,
    private readonly path: string
  ) {
    this.database.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        id TEXT PRIMARY KEY,
        corpus_digest TEXT NOT NULL,
        credit_cap REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
        case_id TEXT NOT NULL,
        profile_key TEXT NOT NULL,
        replicate INTEGER NOT NULL,
        observation_json TEXT NOT NULL,
        PRIMARY KEY(run_id, case_id, profile_key, replicate)
      );
    `);
  }

  static async open(path: string): Promise<ModelEvaluationStore> {
    await ensureDir(dirname(path));
    await chmod(dirname(path), 0o700);
    const store = new ModelEvaluationStore(
      new Database(path, { create: true }),
      path
    );
    await chmod(path, 0o600);
    return store;
  }

  createOrResume(
    corpusDigest: string,
    creditCap = 5_000,
    now = new Date()
  ): EvaluationRun {
    const existing = this.database
      .query<
        {
          id: string;
          corpus_digest: string;
          credit_cap: number;
          created_at: string;
        },
        [string]
      >(
        "SELECT id, corpus_digest, credit_cap, created_at FROM evaluation_runs WHERE corpus_digest = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(corpusDigest);
    if (existing) {
      return {
        id: existing.id,
        corpusDigest: existing.corpus_digest,
        creditCap: existing.credit_cap,
        createdAt: existing.created_at,
      };
    }
    const createdAt = now.toISOString();
    const id = `model-eval-${corpusDigest.slice(0, 12)}-${createdAt.replaceAll(/[^0-9]/g, "").slice(0, 14)}`;
    this.database
      .query(
        "INSERT INTO evaluation_runs (id, corpus_digest, credit_cap, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(id, corpusDigest, creditCap, createdAt);
    return { id, corpusDigest, creditCap, createdAt };
  }

  latestRun(corpusDigest: string): EvaluationRun | undefined {
    const row = this.database
      .query<
        {
          id: string;
          corpus_digest: string;
          credit_cap: number;
          created_at: string;
        },
        [string]
      >(
        "SELECT id, corpus_digest, credit_cap, created_at FROM evaluation_runs WHERE corpus_digest = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(corpusDigest);
    return row
      ? {
          id: row.id,
          corpusDigest: row.corpus_digest,
          creditCap: row.credit_cap,
          createdAt: row.created_at,
        }
      : undefined;
  }

  saveObservation(observation: EvaluationObservation): boolean {
    assertPrivacyMinimal(observation);
    return (
      this.database
        .query(
          "INSERT OR IGNORE INTO observations (run_id, case_id, profile_key, replicate, observation_json) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          observation.runId,
          observation.caseId,
          `${observation.profile.model}:${observation.profile.reasoningEffort}`,
          observation.replicate,
          JSON.stringify(observation)
        ).changes > 0
    );
  }

  observations(runId: string): readonly EvaluationObservation[] {
    return this.database
      .query<{ observation_json: string }, [string]>(
        "SELECT observation_json FROM observations WHERE run_id = ? ORDER BY rowid"
      )
      .all(runId)
      .map((row) => JSON.parse(row.observation_json) as EvaluationObservation);
  }

  close(): void {
    this.database.close();
  }
}
