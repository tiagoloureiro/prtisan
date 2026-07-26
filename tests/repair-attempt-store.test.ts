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
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
