import { describe, expect, test } from "bun:test";

import { readText } from "@/fs.js";
import { writeScaffoldFiles } from "@/scaffold.js";

describe("scaffold", () => {
  test("writes required agent train files", async () => {
    const root = `/tmp/agent-train-scaffold-${crypto.randomUUID()}`;

    const result = await writeScaffoldFiles(root, {
      repo: "o/r",
      targetBranch: "main",
    });

    expect(result.files.map((file) => [file.path, file.status])).toEqual([
      [".sandcastle/agent-train.config.json", "created"],
      [".sandcastle/Dockerfile", "created"],
      [".gitignore", "created"],
    ]);
    const config = await readText(
      `${root}/.sandcastle/agent-train.config.json`
    );
    expect(config).toContain('"repo": "o/r"');
    expect(await readText(`${root}/.sandcastle/Dockerfile`)).toContain(
      "FROM oven/bun:"
    );
    expect(await readText(`${root}/.gitignore`)).toContain(
      ".sandcastle/codex-home/"
    );
  });

  test("skips existing managed files unless force is set", async () => {
    const root = `/tmp/agent-train-scaffold-${crypto.randomUUID()}`;
    await writeScaffoldFiles(root, {
      repo: "o/r",
      targetBranch: "main",
    });
    await Bun.write(`${root}/.sandcastle/Dockerfile`, "custom\n");

    const skipped = await writeScaffoldFiles(root, {
      repo: "o/r",
      targetBranch: "main",
    });
    expect(
      skipped.files.find((file) => file.path === ".sandcastle/Dockerfile")
        ?.status
    ).toBe("skipped");

    const forced = await writeScaffoldFiles(root, {
      repo: "o/r",
      targetBranch: "main",
      force: true,
    });
    expect(
      forced.files.find((file) => file.path === ".sandcastle/Dockerfile")
        ?.status
    ).toBe("updated");
  });
});
