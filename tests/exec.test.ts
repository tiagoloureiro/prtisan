import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { BunCommandRunner, CommandSpawnError } from "@/exec.js";

describe("BunCommandRunner spawn failures", () => {
  test("identifies a missing working directory without exposing posix_spawn", async () => {
    const cwd = join(await mkdtemp(join(tmpdir(), "prtisan-exec-")), "missing");

    const error = await captureSpawnError(() =>
      new BunCommandRunner().run("git", ["status"], { cwd })
    );

    expect(error).toBeInstanceOf(CommandSpawnError);
    expect(error.reason).toBe("missing_cwd");
    expect(error.cwd).toBe(cwd);
    expect(error.message).not.toContain("posix_spawn");
  });

  test("distinguishes an unavailable executable from a missing cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "prtisan-exec-"));

    const error = await captureSpawnError(() =>
      new BunCommandRunner().run("prtisan-command-that-does-not-exist", [], {
        cwd,
      })
    );

    expect(error).toBeInstanceOf(CommandSpawnError);
    expect(error.reason).toBe("missing_executable");
    expect(error.cwd).toBe(cwd);
    expect(error.message).not.toContain("posix_spawn");
  });
});

async function captureSpawnError(
  task: () => Promise<unknown>
): Promise<CommandSpawnError> {
  try {
    await task();
  } catch (error) {
    if (error instanceof CommandSpawnError) return error;
    throw error;
  }
  throw new Error("Expected command spawning to fail.");
}
