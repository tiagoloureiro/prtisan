import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";

import { BunCommandRunner } from "@/exec.js";
import { writeText } from "@/fs.js";
import { defaultManifest } from "@/manifest.js";
import { createSetupBranchChange } from "@/setup-worktree.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("setup branch publication", () => {
  test("reuses an existing setup commit when its managed files are current", async () => {
    const root = `/tmp/prtisan-setup-worktree-${crypto.randomUUID()}`;
    const remote = `${root}-remote.git`;
    temporaryRoots.push(root, remote);
    await git("/tmp", ["init", "--bare", remote]);
    await git("/tmp", ["init", root]);
    await git(root, ["config", "user.name", "Prtisan Test"]);
    await git(root, ["config", "user.email", "prtisan@example.invalid"]);
    await writeText(`${root}/README.md`, "target\n");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "Initial target"]);
    await git(root, ["branch", "-M", "main"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-u", "origin", "main"]);

    const input = {
      root,
      repo: "o/r",
      targetBranch: "main",
      branch: "prtisan/setup",
      remote: "origin",
      manifest: defaultManifest({
        commands: [
          {
            name: "Check",
            command: "bun test",
            timeoutMs: 60_000,
          },
        ],
      }),
    };
    const runner = new BunCommandRunner();

    expect((await createSetupBranchChange(input, runner)).changed).toBe(true);
    const firstHead = await git(remote, [
      "rev-parse",
      "refs/heads/prtisan/setup",
    ]);
    await Bun.sleep(1_100);

    expect((await createSetupBranchChange(input, runner)).changed).toBe(true);
    const secondHead = await git(remote, [
      "rev-parse",
      "refs/heads/prtisan/setup",
    ]);

    expect(secondHead).toBe(firstHead);
  });
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout.trim();
}
