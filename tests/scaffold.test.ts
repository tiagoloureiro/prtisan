import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";

import { readJson, readText, writeText } from "@/fs.js";
import type { PrtisanManifest } from "@/manifest.js";
import { writeScaffoldFiles } from "@/scaffold.js";

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
    const manifest = await readJson<PrtisanManifest>(
      `${root}/.prtisan/manifest.json`
    );
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
        roles: {
          standardsReview: {
            model: "gpt-5.6-sol",
            reasoningEffort: "medium",
          },
        },
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
