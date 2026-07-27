import { Database } from "bun:sqlite";

import { ensureDir } from "@/fs.js";
import { dirname } from "@/path.js";
import { processIsAlive } from "@/validation-lease.js";

import { reduceWorkflow } from "./state.js";
import type { TrainPlan, WorkflowEvent, WorkflowSnapshot } from "./types.js";

export interface EffectRecord {
  readonly key: string;
  readonly status: "started" | "completed";
  readonly result?: unknown;
}

export interface JournalLease {
  readonly repositoryKey: string;
  readonly owner: JournalLeaseOwner;
  release(): Promise<void>;
}

export interface JournalLeaseOwner {
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
}

export class WorkflowLeaseBusyError extends Error {
  constructor(
    readonly ownerPid: number,
    readonly ownerCreatedAt: string
  ) {
    super(
      `Another Prtisan run is active for this repository (PID ${ownerPid}, started ${ownerCreatedAt}).`
    );
    this.name = "WorkflowLeaseBusyError";
  }
}

export interface WorkflowJournal {
  savePlan(plan: TrainPlan, event: WorkflowEvent): Promise<void>;
  loadPlan(planId: string): Promise<TrainPlan | undefined>;
  latestPlan(repositoryKey: string): Promise<TrainPlan | undefined>;
  append(planId: string, event: WorkflowEvent): Promise<void>;
  events(planId: string): Promise<readonly WorkflowEvent[]>;
  snapshot(planId: string): Promise<WorkflowSnapshot | undefined>;
  effect(planId: string, key: string): Promise<EffectRecord | undefined>;
  startEffect(planId: string, key: string, at: string): Promise<void>;
  completeEffect(
    planId: string,
    key: string,
    result: unknown,
    at: string
  ): Promise<void>;
  acquire(
    repositoryKey: string,
    owner: JournalLeaseOwner,
    now: number,
    ttlMs: number
  ): Promise<JournalLease>;
}

export class SqliteWorkflowJournal implements WorkflowJournal {
  private constructor(
    private readonly database: Database,
    private readonly path: string
  ) {
    this.migrate();
  }

  static async open(path: string): Promise<SqliteWorkflowJournal> {
    await ensureDir(dirname(path));
    return new SqliteWorkflowJournal(
      new Database(path, { create: true }),
      path
    );
  }

  close(): void {
    this.database.close();
  }

  async savePlan(plan: TrainPlan, event: WorkflowEvent): Promise<void> {
    const transaction = this.database.transaction(() => {
      this.database
        .query(
          "INSERT OR IGNORE INTO plans (id, repository_key, plan_json, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(plan.id, plan.repositoryKey, JSON.stringify(plan), plan.createdAt);
      const count = this.database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM events WHERE plan_id = ?"
        )
        .get(plan.id)?.count;
      if (count === 0) {
        this.insertEvent(plan.id, event);
      }
    });
    transaction();
  }

  async loadPlan(planId: string): Promise<TrainPlan | undefined> {
    const row = this.database
      .query<{ plan_json: string }, [string]>(
        "SELECT plan_json FROM plans WHERE id = ?"
      )
      .get(planId);
    return row ? (JSON.parse(row.plan_json) as TrainPlan) : undefined;
  }

  async latestPlan(repositoryKey: string): Promise<TrainPlan | undefined> {
    const row = this.database
      .query<{ plan_json: string }, [string]>(
        "SELECT plan_json FROM plans WHERE repository_key = ? ORDER BY created_at DESC, id DESC LIMIT 1"
      )
      .get(repositoryKey);
    return row ? (JSON.parse(row.plan_json) as TrainPlan) : undefined;
  }

  async append(planId: string, event: WorkflowEvent): Promise<void> {
    this.insertEvent(planId, event);
  }

  async events(planId: string): Promise<readonly WorkflowEvent[]> {
    return this.database
      .query<{ event_json: string }, [string]>(
        "SELECT event_json FROM events WHERE plan_id = ? ORDER BY sequence"
      )
      .all(planId)
      .map((row) => JSON.parse(row.event_json) as WorkflowEvent);
  }

  async snapshot(planId: string): Promise<WorkflowSnapshot | undefined> {
    const events = await this.events(planId);
    return events.length > 0 ? reduceWorkflow(events) : undefined;
  }

  async effect(planId: string, key: string): Promise<EffectRecord | undefined> {
    const row = this.database
      .query<
        { effect_key: string; status: string; result_json: string | null },
        [string, string]
      >(
        "SELECT effect_key, status, result_json FROM effects WHERE plan_id = ? AND effect_key = ?"
      )
      .get(planId, key);
    if (!row) return undefined;
    return {
      key: row.effect_key,
      status: row.status as EffectRecord["status"],
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
    };
  }

  async startEffect(planId: string, key: string, at: string): Promise<void> {
    this.database
      .query(
        "INSERT OR IGNORE INTO effects (plan_id, effect_key, status, started_at) VALUES (?, ?, 'started', ?)"
      )
      .run(planId, key, at);
  }

  async completeEffect(
    planId: string,
    key: string,
    result: unknown,
    at: string
  ): Promise<void> {
    this.database
      .query(
        "UPDATE effects SET status = 'completed', result_json = ?, completed_at = ? WHERE plan_id = ? AND effect_key = ?"
      )
      .run(JSON.stringify(result ?? null), at, planId, key);
  }

  async acquire(
    repositoryKey: string,
    owner: JournalLeaseOwner,
    now: number,
    ttlMs: number
  ): Promise<JournalLease> {
    const encodedOwner = JSON.stringify(owner);
    const transaction = this.database.transaction(() => {
      const current = this.database
        .query<{ owner: string; acquired_at: number }, [string]>(
          "SELECT owner, acquired_at FROM leases WHERE repository_key = ?"
        )
        .get(repositoryKey);
      if (
        current &&
        current.owner !== encodedOwner &&
        now - current.acquired_at < ttlMs
      ) {
        const currentOwner = parseLeaseOwner(current.owner);
        if (currentOwner && processIsAlive(currentOwner.pid)) {
          throw new WorkflowLeaseBusyError(
            currentOwner.pid,
            currentOwner.createdAt
          );
        }
      }
      this.database
        .query(
          "INSERT INTO leases (repository_key, owner, acquired_at) VALUES (?, ?, ?) ON CONFLICT(repository_key) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at"
        )
        .run(repositoryKey, encodedOwner, now);
    });
    transaction();

    return {
      repositoryKey,
      owner,
      release: async () => {
        this.database
          .query("DELETE FROM leases WHERE repository_key = ? AND owner = ?")
          .run(repositoryKey, encodedOwner);
      },
    };
  }

  private insertEvent(planId: string, event: WorkflowEvent): void {
    this.database
      .query(
        "INSERT INTO events (plan_id, event_json, created_at) VALUES (?, ?, ?)"
      )
      .run(planId, JSON.stringify(event), event.at);
  }

  private migrate(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        repository_key TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effects (
        plan_id TEXT NOT NULL REFERENCES plans(id),
        effect_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('started', 'completed')),
        result_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY(plan_id, effect_key)
      );
      CREATE TABLE IF NOT EXISTS leases (
        repository_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at INTEGER NOT NULL
      );
    `);
  }
}

export class InMemoryWorkflowJournal implements WorkflowJournal {
  private readonly plans = new Map<string, TrainPlan>();
  private readonly eventStreams = new Map<string, WorkflowEvent[]>();
  private readonly effects = new Map<string, EffectRecord>();
  private readonly leases = new Map<
    string,
    { readonly owner: JournalLeaseOwner; readonly acquiredAt: number }
  >();

  async savePlan(plan: TrainPlan, event: WorkflowEvent): Promise<void> {
    if (!this.plans.has(plan.id)) {
      this.plans.set(plan.id, plan);
      this.eventStreams.set(plan.id, [event]);
    }
  }

  async loadPlan(planId: string): Promise<TrainPlan | undefined> {
    return this.plans.get(planId);
  }

  async latestPlan(repositoryKey: string): Promise<TrainPlan | undefined> {
    return [...this.plans.values()]
      .filter((plan) => plan.repositoryKey === repositoryKey)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id)
      )[0];
  }

  async append(planId: string, event: WorkflowEvent): Promise<void> {
    const events = this.eventStreams.get(planId);
    if (!events) throw new Error(`Unknown plan ${planId}.`);
    events.push(event);
  }

  async events(planId: string): Promise<readonly WorkflowEvent[]> {
    return [...(this.eventStreams.get(planId) ?? [])];
  }

  async snapshot(planId: string): Promise<WorkflowSnapshot | undefined> {
    const events = await this.events(planId);
    return events.length > 0 ? reduceWorkflow(events) : undefined;
  }

  async effect(planId: string, key: string): Promise<EffectRecord | undefined> {
    return this.effects.get(`${planId}:${key}`);
  }

  async startEffect(planId: string, key: string): Promise<void> {
    const effectKey = `${planId}:${key}`;
    if (!this.effects.has(effectKey)) {
      this.effects.set(effectKey, { key, status: "started" });
    }
  }

  async completeEffect(
    planId: string,
    key: string,
    result: unknown
  ): Promise<void> {
    this.effects.set(`${planId}:${key}`, {
      key,
      status: "completed",
      result,
    });
  }

  async acquire(
    repositoryKey: string,
    owner: JournalLeaseOwner,
    now: number,
    ttlMs: number
  ): Promise<JournalLease> {
    const current = this.leases.get(repositoryKey);
    if (
      current &&
      current.owner.token !== owner.token &&
      now - current.acquiredAt < ttlMs &&
      processIsAlive(current.owner.pid)
    ) {
      throw new WorkflowLeaseBusyError(
        current.owner.pid,
        current.owner.createdAt
      );
    }
    this.leases.set(repositoryKey, { owner, acquiredAt: now });
    return {
      repositoryKey,
      owner,
      release: async () => {
        if (this.leases.get(repositoryKey)?.owner.token === owner.token) {
          this.leases.delete(repositoryKey);
        }
      },
    };
  }
}

function parseLeaseOwner(value: string): JournalLeaseOwner | undefined {
  try {
    const owner = JSON.parse(value) as Partial<JournalLeaseOwner>;
    if (
      typeof owner.token !== "string" ||
      owner.token.length === 0 ||
      !Number.isInteger(owner.pid) ||
      (owner.pid ?? 0) <= 0 ||
      typeof owner.createdAt !== "string" ||
      !Number.isFinite(new Date(owner.createdAt).getTime())
    ) {
      return undefined;
    }
    return owner as JournalLeaseOwner;
  } catch {
    return undefined;
  }
}
