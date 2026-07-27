import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { SqliteAgentTelemetrySink } from "@/agent-telemetry.js";

describe("agent telemetry", () => {
  test("stores only privacy-minimal metrics in a permission-restricted database", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-telemetry-"));
    await chmod(root, 0o755);
    const path = join(root, "private", "agent-invocations.sqlite");
    const sink = new SqliteAgentTelemetrySink(() => path);

    await sink.record({
      cwd: "/secret/source/path",
      at: "2026-07-27T00:00:00.000Z",
      terminalOutcome: "completed",
      invocation: {
        role: "ciRepair",
        profile: {
          model: "gpt-5.6-luna",
          reasoningEffort: "medium",
        },
        promptChars: 1_234,
        agentDurationMs: 2_345,
        iterations: 2,
        retryCount: 1,
        cacheUsed: true,
        usage: {
          inputTokens: 100,
          cacheCreationInputTokens: 20,
          cacheReadInputTokens: 30,
          outputTokens: 40,
        },
        creditCost: {
          rateCardId: "rate-card",
          credits: 0.0123,
        },
      },
    });

    expect((await stat(root)).mode & 0o777).toBe(0o755);
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const database = new Database(path, { readonly: true });
    try {
      const columns = database
        .query<{ name: string }, []>("PRAGMA table_info(agent_invocations)")
        .all()
        .map((column) => column.name);
      expect(columns).not.toContain("prompt");
      expect(columns).not.toContain("prompt_chars");
      expect(columns).not.toContain("iterations");
      expect(columns).not.toContain("output");
      expect(columns).not.toContain("path");
      expect(columns).not.toContain("finding");
      expect(columns).not.toContain("patch");

      const row = database
        .query<
          {
            role: string;
            model: string;
            reasoning_effort: string;
            retry_count: number;
            cache_used: number;
            terminal_outcome: string;
          },
          []
        >("SELECT * FROM agent_invocations")
        .get();
      expect(row).toMatchObject({
        role: "ciRepair",
        model: "gpt-5.6-luna",
        reasoning_effort: "medium",
        retry_count: 1,
        cache_used: 1,
        terminal_outcome: "completed",
      });

      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("/secret/source/path");
    } finally {
      database.close();
    }
  });

  test("migrates an earlier metrics table without retaining prompt metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-telemetry-migrate-"));
    const path = join(root, "private", "agent-invocations.sqlite");
    await mkdir(join(root, "private"));
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        prompt_chars INTEGER NOT NULL,
        agent_duration_ms INTEGER NOT NULL,
        iterations INTEGER NOT NULL,
        input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        output_tokens INTEGER,
        rate_card_id TEXT,
        credits REAL,
        terminal_outcome TEXT NOT NULL
      );
      INSERT INTO agent_invocations (
        recorded_at, role, model, reasoning_effort, prompt_chars,
        agent_duration_ms, iterations, terminal_outcome
      ) VALUES (
        '2026-07-26T00:00:00.000Z', 'standardsReview',
        'gpt-5.6-sol', 'medium', 999, 100, 1, 'completed'
      );
    `);
    legacy.close();

    const sink = new SqliteAgentTelemetrySink(() => path);
    await sink.record({
      cwd: "/repository",
      terminalOutcome: "completed",
      invocation: {
        role: "specReview",
        profile: {
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
        },
        promptChars: 123,
        agentDurationMs: 200,
        iterations: 1,
        retryCount: 0,
      },
    });

    const migrated = new Database(path, { readonly: true });
    try {
      const columns = migrated
        .query<{ name: string }, []>("PRAGMA table_info(agent_invocations)")
        .all()
        .map((column) => column.name);
      expect(columns).not.toContain("prompt_chars");
      expect(columns).not.toContain("iterations");
      expect(
        migrated
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM agent_invocations"
          )
          .get()?.count
      ).toBe(2);
    } finally {
      migrated.close();
    }
  });
});
