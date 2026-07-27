import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { FileRepairAttemptStore } from "@/repair-attempt-store.js";

describe("repair attempt persistence", () => {
  test("atomically permits one claim across store instances", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "prtisan-attempt-store-"));
    try {
      const first = new FileRepairAttemptStore(cwd);
      const second = new FileRepairAttemptStore(cwd);

      const claims = await Promise.all([
        first.claim("ci:fingerprint"),
        second.claim("ci:fingerprint"),
      ]);

      expect(claims.toSorted()).toEqual([false, true]);
      expect(await first.claim("ci:fingerprint")).toBe(false);
      await first.release("ci:fingerprint");
      expect(await second.claim("ci:fingerprint")).toBe(true);
      await first.release("missing");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reclaims an expired repair lease after an interrupted process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "prtisan-attempt-store-"));
    try {
      let now = Date.parse("2026-07-26T00:00:00.000Z");
      const first = new FileRepairAttemptStore(cwd, 1_000, () => now);
      expect(await first.claim("ci:o/r:pr-1:evidence")).toBe(true);
      now += 1_001;
      const resumed = new FileRepairAttemptStore(cwd, 1_000, () => now);
      expect(await resumed.claim("ci:o/r:pr-1:evidence")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
