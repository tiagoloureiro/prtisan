import { chmod } from "node:fs/promises";
import { Database } from "bun:sqlite";

import { ensureDir } from "./fs.js";
import { dirname } from "./path.js";
import { prtisanRepositoryStatePath } from "./prtisan-paths.js";
import type { AgentInvocationMetrics } from "./types.js";

export type AgentTerminalOutcome =
  "completed" | "infrastructure_failed" | "execution_failed";

export interface AgentTelemetrySink {
  record(input: {
    readonly cwd: string;
    readonly invocation: AgentInvocationMetrics;
    readonly terminalOutcome: AgentTerminalOutcome;
    readonly at?: string;
  }): Promise<void>;
}

export class SqliteAgentTelemetrySink implements AgentTelemetrySink {
  constructor(
    private readonly pathForRepository: (
      cwd: string
    ) => string = defaultTelemetryPath
  ) {}

  async record(input: {
    readonly cwd: string;
    readonly invocation: AgentInvocationMetrics;
    readonly terminalOutcome: AgentTerminalOutcome;
    readonly at?: string;
  }): Promise<void> {
    const path = this.pathForRepository(input.cwd);
    await ensureDir(dirname(path));
    await chmod(dirname(path), 0o700);

    const database = new Database(path, { create: true });
    try {
      database.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE IF NOT EXISTS agent_invocations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          recorded_at TEXT NOT NULL,
          role TEXT NOT NULL,
          model TEXT NOT NULL,
          reasoning_effort TEXT NOT NULL,
          agent_duration_ms INTEGER NOT NULL,
          retry_count INTEGER NOT NULL,
          cache_used INTEGER,
          input_tokens INTEGER,
          cache_creation_input_tokens INTEGER,
          cache_read_input_tokens INTEGER,
          output_tokens INTEGER,
          rate_card_id TEXT,
          credits REAL,
          terminal_outcome TEXT NOT NULL
        )
      `);
      const columns = new Set(
        database
          .query<{ name: string }, []>("PRAGMA table_info(agent_invocations)")
          .all()
          .map((column) => column.name)
      );
      if (!columns.has("retry_count")) {
        database.exec(
          "ALTER TABLE agent_invocations ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0"
        );
      }
      if (!columns.has("cache_used")) {
        database.exec(
          "ALTER TABLE agent_invocations ADD COLUMN cache_used INTEGER"
        );
      }
      if (columns.has("prompt_chars") || columns.has("iterations")) {
        database.exec(`
          ALTER TABLE agent_invocations RENAME TO agent_invocations_legacy;
          CREATE TABLE agent_invocations (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at TEXT NOT NULL,
            role TEXT NOT NULL,
            model TEXT NOT NULL,
            reasoning_effort TEXT NOT NULL,
            agent_duration_ms INTEGER NOT NULL,
            retry_count INTEGER NOT NULL,
            cache_used INTEGER,
            input_tokens INTEGER,
            cache_creation_input_tokens INTEGER,
            cache_read_input_tokens INTEGER,
            output_tokens INTEGER,
            rate_card_id TEXT,
            credits REAL,
            terminal_outcome TEXT NOT NULL
          );
          INSERT INTO agent_invocations (
            sequence, recorded_at, role, model, reasoning_effort,
            agent_duration_ms, retry_count, cache_used, input_tokens,
            cache_creation_input_tokens, cache_read_input_tokens,
            output_tokens, rate_card_id, credits, terminal_outcome
          )
          SELECT
            sequence, recorded_at, role, model, reasoning_effort,
            agent_duration_ms, retry_count, cache_used, input_tokens,
            cache_creation_input_tokens, cache_read_input_tokens,
            output_tokens, rate_card_id, credits, terminal_outcome
          FROM agent_invocations_legacy;
          DROP TABLE agent_invocations_legacy;
        `);
      }
      const { invocation } = input;
      database
        .query(
          `INSERT INTO agent_invocations (
            recorded_at, role, model, reasoning_effort,
            agent_duration_ms, retry_count, cache_used, input_tokens,
            cache_creation_input_tokens, cache_read_input_tokens,
            output_tokens, rate_card_id, credits, terminal_outcome
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.at ?? new Date().toISOString(),
          invocation.role,
          invocation.profile.model,
          invocation.profile.reasoningEffort,
          invocation.agentDurationMs,
          invocation.retryCount,
          invocation.cacheUsed === undefined
            ? null
            : invocation.cacheUsed
              ? 1
              : 0,
          invocation.usage?.inputTokens ?? null,
          invocation.usage?.cacheCreationInputTokens ?? null,
          invocation.usage?.cacheReadInputTokens ?? null,
          invocation.usage?.outputTokens ?? null,
          invocation.creditCost?.rateCardId ?? null,
          invocation.creditCost?.credits ?? null,
          input.terminalOutcome
        );
    } finally {
      database.close();
      await chmod(path, 0o600);
    }
  }
}

function defaultTelemetryPath(cwd: string): string {
  return prtisanRepositoryStatePath(
    cwd,
    "telemetry",
    "agent-invocations.sqlite"
  );
}
