import { describe, expect, test } from "bun:test";

import {
  defaultManifest,
  loadManifestAtRef,
  ManifestError,
  manifestForSetup,
  ManifestUpgradeRequiredError,
  parseManifest,
} from "@/manifest.js";

import { FakeRunner, QUALITY_FIRST_AGENT_PROFILES } from "./helpers.js";

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

    expect(loaded.manifest.schemaVersion).toBe(2);
    expect(loaded.manifest.verification.commands[0]?.name).toBe("test");
    expect(loaded.manifest.limits.maxRepairCandidates).toBe(3);
    expect(loaded.manifest.limits.maxCandidatesPerCause).toBe(2);
    expect(loaded.manifest.codex.roles).toEqual(QUALITY_FIRST_AGENT_PROFILES);
  });

  test("requires exactly one profile for every supported role", () => {
    const manifest = defaultManifest();
    const missing = JSON.parse(JSON.stringify(manifest)) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    delete missing.codex?.roles?.standardsReview;
    expect(() =>
      parseManifest(JSON.stringify(missing), "missing role")
    ).toThrow(ManifestError);

    const extra = JSON.parse(JSON.stringify(manifest)) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    if (extra.codex?.roles) {
      extra.codex.roles.legacyReview = {
        model: "legacy",
        reasoningEffort: "low",
      };
    }
    expect(() => parseManifest(JSON.stringify(extra), "extra role")).toThrow(
      ManifestError
    );
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

  test("distinguishes a valid v1 policy from malformed configuration", () => {
    const legacy = legacyManifest();

    expect(() =>
      parseManifest(JSON.stringify(legacy), "legacy fixture")
    ).toThrow(ManifestUpgradeRequiredError);
    expect(() =>
      parseManifest(
        JSON.stringify({ ...legacy, codex: { reviewModel: "" } }),
        "malformed fixture"
      )
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest(
        JSON.stringify({ ...legacy, codex: { reviewModel: "" } }),
        "malformed fixture"
      )
    ).not.toThrow(ManifestUpgradeRequiredError);
  });

  test("builds a reviewed v2 setup proposal while preserving non-Codex policy", () => {
    const legacy = legacyManifest();
    const upgraded = manifestForSetup(JSON.stringify(legacy), "legacy fixture");

    expect(upgraded).toMatchObject({
      schemaVersion: 2,
      targetBranch: legacy.targetBranch,
      sandbox: legacy.sandbox,
      verification: legacy.verification,
      contract: legacy.contract,
      limits: legacy.limits,
    });
    expect(upgraded.codex.roles).toEqual(QUALITY_FIRST_AGENT_PROFILES);
  });
});

function legacyManifest() {
  return {
    schemaVersion: 1 as const,
    targetBranch: "release",
    sandbox: {
      provider: "docker" as const,
      dockerfile: ".prtisan/custom.Dockerfile",
      context: "packages/app",
      imageName: "custom:repository",
      cpus: 3,
    },
    verification: {
      bootstrap: {
        name: "install",
        command: "bun install",
        timeoutMs: 60_000,
      },
      commands: [{ name: "test", command: "bun test", timeoutMs: 120_000 }],
    },
    contract: { prBodySections: ["Why", "Verification"] },
    codex: {
      reviewModel: "legacy-review",
      repairModel: "legacy-repair",
      reviewEffort: "low" as const,
      repairEffort: "high" as const,
    },
    limits: {
      readConcurrency: 3,
      githubConcurrency: 5,
      maxRepairCandidates: 3 as const,
      maxCandidatesPerCause: 2 as const,
      applyLeaseTtlMs: 90_000,
    },
  };
}
