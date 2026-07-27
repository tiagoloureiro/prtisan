import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { BunCommandRunner } from "@/exec.js";
import { prtisanRepositoryDataPath } from "@/prtisan-paths.js";
import { pruneRuntimeArtifacts } from "@/retention.js";

import { testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("runtime retention", () => {
  test("keeps the newest bounded runs and preserves only oversized log tails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "prtisan-retention-test-"));
    temporaryDirectories.push(cwd);
    const runsRoot = prtisanRepositoryDataPath(cwd, "runs");
    const now = Date.now();
    for (const [index, run] of ["run-1", "run-2", "run-3"].entries()) {
      const logs = join(runsRoot, run, "logs");
      await mkdir(logs, { recursive: true });
      await writeFile(join(logs, "agent.log"), `prefix-${"x".repeat(40)}tail`);
      const timestamp = new Date(now - (3 - index) * 1_000);
      await utimes(join(runsRoot, run), timestamp, timestamp);
    }
    const defaults = testConfig().retention;

    await pruneRuntimeArtifacts({
      cwd,
      config: testConfig({
        retention: {
          ...defaults,
          ttlDays: 365,
          maxLogBytes: 16,
          maxRuns: 2,
          maxTotalBytes: 1024 * 1024,
        },
      }),
      runner: new BunCommandRunner(),
    });

    await expect(stat(join(runsRoot, "run-1"))).rejects.toThrow();
    expect((await stat(join(runsRoot, "run-2"))).isDirectory()).toBe(true);
    const tail = await readFile(
      join(runsRoot, "run-3", "logs", "agent.log"),
      "utf8"
    );
    expect(Buffer.byteLength(tail)).toBe(16);
    expect(tail.endsWith("tail")).toBe(true);
  });
});
