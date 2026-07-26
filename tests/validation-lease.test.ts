import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { stableDigest } from "@/validation-hardening.js";
import { singleFlight, ValidationLeaseManager } from "@/validation-lease.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("validation leases", () => {
  test("reclaims a fresh lease only when its owner PID is dead", async () => {
    const cwd = await temporaryDirectory();
    const key = "o/r:117:snapshot";
    const lockRoot = join(cwd, ".sandcastle", "locks");
    const lockPath = join(lockRoot, stableDigest(key));
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        createdAt: new Date().toISOString(),
        snapshotKey: key,
        token: "dead-owner",
      })
    );

    const lease = await new ValidationLeaseManager(
      cwd,
      2 * 60 * 60 * 1000
    ).acquire(key, { waitMs: 1_000 });
    await lease.release();

    expect(await readdir(lockRoot)).toEqual([]);
  });

  test("reclaims an expired lease even while its PID is alive", async () => {
    const cwd = await temporaryDirectory();
    const key = "o/r:117:expired";
    const lockRoot = join(cwd, ".sandcastle", "locks");
    const lockPath = join(lockRoot, stableDigest(key));
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(Date.now() - 10_000).toISOString(),
        snapshotKey: key,
        token: "expired-owner",
      })
    );

    const lease = await new ValidationLeaseManager(cwd, 1).acquire(key, {
      waitMs: 1_000,
    });
    await lease.release();

    expect(await readdir(lockRoot)).toEqual([]);
  });

  test("coalesces concurrent callers into one in-process run", async () => {
    let executions = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = async () => {
      executions += 1;
      await gate;
      return { outcome: "passed" };
    };

    const first = singleFlight("same-snapshot", task);
    const second = singleFlight("same-snapshot", task);
    release?.();

    expect(await Promise.all([first, second])).toEqual([
      { outcome: "passed" },
      { outcome: "passed" },
    ]);
    expect(executions).toBe(1);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "prtisan-lease-test-"));
  temporaryDirectories.push(path);
  return path;
}
