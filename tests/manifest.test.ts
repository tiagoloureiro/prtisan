import { describe, expect, test } from "bun:test";

import {
  defaultManifest,
  loadManifestAtRef,
  ManifestError,
  parseManifest,
} from "@/manifest.js";

import { FakeRunner } from "./helpers.js";

describe("Prtisan manifest", () => {
  test("accepts the versioned, explicit runtime contract", () => {
    const manifest = defaultManifest({
      targetBranch: "main",
      bootstrap: {
        name: "install",
        command: "pnpm install",
        timeoutMs: 60_000,
      },
      commands: [{ name: "test", command: "pnpm test", timeoutMs: 120_000 }],
    });

    const loaded = parseManifest(JSON.stringify(manifest), "fixture");

    expect(loaded.manifest.schemaVersion).toBe(1);
    expect(loaded.manifest.verification.commands[0]?.name).toBe("test");
    expect(loaded.manifest.limits.maxRepairCandidates).toBe(3);
    expect(loaded.manifest.limits.maxCandidatesPerCause).toBe(2);
  });

  test("loads policy from the exact requested base ref", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      JSON.stringify(
        defaultManifest({
          targetBranch: "main",
          commands: [
            { name: "test", command: "pnpm test", timeoutMs: 120_000 },
          ],
        })
      )
    );

    await loadManifestAtRef({ runner, cwd: "/repo", ref: "base-sha" });

    expect(runner.calls[0]?.args).toEqual([
      "show",
      "base-sha:.prtisan/manifest.json",
    ]);
  });

  test("fails closed when the tracked manifest is missing", async () => {
    const runner = new FakeRunner();
    runner.enqueue("", 1, "not found");

    await expect(
      loadManifestAtRef({ runner, cwd: "/repo", ref: "base-sha" })
    ).rejects.toBeInstanceOf(ManifestError);
  });
});
