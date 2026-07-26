import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { loadConfig } from "@/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("validation configuration compatibility", () => {
  test("keeps legacy configs valid and maps keepSessions to failure-only retention", async () => {
    const cwd = await configDirectory({
      repo: "o/r",
      keepSessions: true,
    });

    const config = await loadConfig(cwd, "config.json");

    expect(config.runtime).toMatchObject({
      autoProvision: true,
      verificationMode: "auto",
    });
    expect(config.validation).toMatchObject({
      maxRepairRounds: 1,
      maxAgentRunsPerHead: 4,
      promptCharBudget: 32_000,
    });
    expect(config.retention).toMatchObject({
      keepSessions: true,
      sessionPolicy: "failures",
      maxRuns: 50,
      maxTotalBytes: 512 * 1024 * 1024,
    });
  });

  test("maps keepSessions false to none and honors an explicit policy", async () => {
    const disabled = await configDirectory({
      repo: "o/r",
      keepSessions: false,
    });
    const all = await configDirectory({
      repo: "o/r",
      keepSessions: false,
      sessionPolicy: "all",
    });

    expect(
      (await loadConfig(disabled, "config.json")).retention.sessionPolicy
    ).toBe("none");
    expect((await loadConfig(all, "config.json")).retention).toMatchObject({
      keepSessions: true,
      sessionPolicy: "all",
    });
  });

  test("rejects attempts to raise hard validation budgets", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      join(cwd, "config.json"),
      JSON.stringify({
        repo: "o/r",
        validation: {
          maxAgentRunsPerHead: 5,
        },
      })
    );

    await expect(loadConfig(cwd, "config.json")).rejects.toThrow();
  });
});

async function configDirectory(retention: Record<string, unknown>) {
  const cwd = await temporaryDirectory();
  await writeFile(
    join(cwd, "config.json"),
    JSON.stringify({ repo: "o/r", retention })
  );
  return cwd;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "prtisan-config-test-"));
  temporaryDirectories.push(path);
  return path;
}
