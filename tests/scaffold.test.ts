import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";

import { readJson, readText, writeText } from "@/fs.js";
import type { PrtisanManifest } from "@/manifest.js";
import { writeScaffoldFiles } from "@/scaffold.js";

import { QUALITY_FIRST_AGENT_PROFILES } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("Prtisan setup scaffold", () => {
  test("writes the tracked manifest and Sandcastle Dockerfile", async () => {
    const root = `/tmp/prtisan-scaffold-${crypto.randomUUID()}`;
    roots.push(root);
    await writeText(
      `${root}/package.json`,
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: { check: "biome check .", test: "bun test" },
      })
    );

    const result = await writeScaffoldFiles(root, {
      repo: "o/r",
      targetBranch: "main",
    });

    expect(result.files.map((file) => [file.path, file.status])).toEqual([
      [".prtisan/manifest.json", "created"],
      [".prtisan/Dockerfile", "created"],
    ]);
    const manifestPath = `${root}/.prtisan/manifest.json`;
    const manifestContents = await readText(manifestPath);
    const manifest = await readJson<PrtisanManifest>(manifestPath);
    expect(manifestContents).toContain(
      '  "contract": {\n    "prBodySections": ["Summary", "Acceptance criteria"]\n  },'
    );
    expect(manifestContents.endsWith("\n")).toBe(true);
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      targetBranch: "main",
      sandbox: {
        provider: "docker",
        dockerfile: ".prtisan/Dockerfile",
      },
      verification: {
        bootstrap: { command: "pnpm install --frozen-lockfile" },
      },
      codex: {
        roles: QUALITY_FIRST_AGENT_PROFILES,
      },
    });
    expect(
      manifest.verification.commands.map(
        (value: { command: string }) => value.command
      )
    ).toEqual(["pnpm check", "pnpm test"]);
    expect(await readText(`${root}/.prtisan/Dockerfile`)).toContain(
      "CODEX_HOME=/home/agent/.codex-prtisan"
    );
  });

  test("does not overwrite an existing manifest without force", async () => {
    const root = `/tmp/prtisan-scaffold-${crypto.randomUUID()}`;
    roots.push(root);
    await writeText(`${root}/.prtisan/manifest.json`, "custom\n");
    const skipped = await writeScaffoldFiles(root, {
      repo: "o/r",
      targetBranch: "main",
    });
    expect(
      skipped.files.find((file) => file.path === ".prtisan/manifest.json")
        ?.status
    ).toBe("skipped");
    expect(await readText(`${root}/.prtisan/manifest.json`)).toBe("custom\n");
  });
});
