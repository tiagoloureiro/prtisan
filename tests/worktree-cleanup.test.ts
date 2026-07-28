import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  BunCommandRunner,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  mustRun,
} from "@/exec.js";
import { reconcilePrtisanWorktrees } from "@/worktree-cleanup.js";

describe("Prtisan worktree cleanup", () => {
  test("removes a stale review worktree containing only the generated pnpm store", async () => {
    const cwd = await createRepository();
    const worktree = join(
      cwd,
      ".sandcastle",
      "worktrees",
      "prtisan-review-pr-117-standards-dead"
    );
    await createReviewWorktree(cwd, worktree, "standards-dead");
    await mkdir(join(worktree, ".pnpm-store", "v11"), { recursive: true });
    await writeFile(join(worktree, ".pnpm-store", "v11", "cache"), "cache");

    const cleaned = await reconcilePrtisanWorktrees(
      new BunCommandRunner(),
      cwd
    );

    expect(cleaned.removed).toEqual([worktree]);
    expect(await directoryExists(worktree)).toBe(false);
  });

  test("removes a live repair worktree containing only the generated pnpm store", async () => {
    const cwd = await createRepository();
    const worktree = join(
      cwd,
      ".sandcastle",
      "worktrees",
      "prtisan-repair-pr-117-cache"
    );
    await createNamedWorktree(cwd, worktree, "prtisan/repair/pr-117-cache");
    await mkdir(join(worktree, ".pnpm-store", "v11"), { recursive: true });
    await writeFile(join(worktree, ".pnpm-store", "v11", "cache"), "cache");

    const cleaned = await reconcilePrtisanWorktrees(
      new BunCommandRunner(),
      cwd
    );

    expect(cleaned.removed).toEqual([worktree]);
    expect(await directoryExists(worktree)).toBe(false);
  });

  test("preserves a review worktree with any non-cache change", async () => {
    const cwd = await createRepository();
    const worktree = join(
      cwd,
      ".sandcastle",
      "worktrees",
      "prtisan-review-pr-117-spec-user"
    );
    await createReviewWorktree(cwd, worktree, "spec-user");
    await mkdir(join(worktree, ".pnpm-store", "v11"), { recursive: true });
    await writeFile(join(worktree, ".pnpm-store", "v11", "cache"), "cache");
    await writeFile(join(worktree, "user-change.txt"), "keep me");

    const cleaned = await reconcilePrtisanWorktrees(
      new BunCommandRunner(),
      cwd
    );

    expect(cleaned.preserved).toEqual([worktree]);
    expect(await directoryExists(worktree)).toBe(true);
  });

  test("prunes a registered review worktree whose directory no longer exists", async () => {
    const cwd = await createRepository();
    const worktree = join(
      cwd,
      ".sandcastle",
      "worktrees",
      "prtisan-review-pr-117-spec-crashed"
    );
    await createReviewWorktree(cwd, worktree, "spec-crashed");
    await rm(worktree, { recursive: true, force: true });

    const cleaned = await reconcilePrtisanWorktrees(
      new BunCommandRunner(),
      cwd
    );

    expect(cleaned.removed).toEqual([]);
    expect(await registeredWorktrees(cwd)).not.toContain(worktree);
  });

  test("prunes multiple dead review, repair, and legacy worktree records", async () => {
    const cwd = await createRepository();
    const root = join(cwd, ".sandcastle", "worktrees");
    const fixtures = [
      {
        path: join(root, "prtisan-review-pr-117-spec-dead"),
        branch: "prtisan/review/pr-117-spec-dead",
      },
      {
        path: join(root, "prtisan-repair-pr-117-dead"),
        branch: "prtisan/repair/pr-117-dead",
      },
      {
        path: join(root, "agent-train-review-pr-117-standards-dead"),
        branch: "agent-train/review/pr-117-standards-dead",
      },
    ];
    for (const fixture of fixtures) {
      await createNamedWorktree(cwd, fixture.path, fixture.branch);
      await rm(fixture.path, { recursive: true, force: true });
    }

    await reconcilePrtisanWorktrees(new BunCommandRunner(), cwd);

    const registered = await registeredWorktrees(cwd);
    for (const fixture of fixtures) {
      expect(registered).not.toContain(fixture.path);
    }
  });

  test("skips a locked review worktree whose directory is unavailable", async () => {
    const cwd = await createRepository();
    const worktree = join(
      cwd,
      ".sandcastle",
      "worktrees",
      "prtisan-review-pr-117-spec-locked"
    );
    await createReviewWorktree(cwd, worktree, "spec-locked");
    await mustRun(
      new BunCommandRunner(),
      "git",
      ["worktree", "lock", worktree],
      {
        cwd,
      }
    );
    await rm(worktree, { recursive: true, force: true });

    const cleaned = await reconcilePrtisanWorktrees(
      new BunCommandRunner(),
      cwd
    );

    expect(cleaned.skipped).toEqual([worktree]);
    expect(await registeredWorktrees(cwd)).toContain(worktree);
  });

  test("recovers when a review worktree disappears during status inspection", async () => {
    const cwd = await createRepository();
    const worktree = join(
      cwd,
      ".sandcastle",
      "worktrees",
      "prtisan-review-pr-117-spec-race"
    );
    await createReviewWorktree(cwd, worktree, "spec-race");
    const runner = new DisappearingWorktreeRunner(worktree);

    const cleaned = await reconcilePrtisanWorktrees(runner, cwd);

    expect(cleaned.skipped).toEqual([]);
    expect(await registeredWorktrees(cwd)).not.toContain(worktree);
  });
});

async function createRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "prtisan-worktree-cleanup-"));
  const runner = new BunCommandRunner();
  await mustRun(runner, "git", ["init", "--initial-branch=main"], { cwd });
  await mustRun(runner, "git", ["config", "user.name", "Test User"], { cwd });
  await mustRun(runner, "git", ["config", "user.email", "test@example.com"], {
    cwd,
  });
  await writeFile(join(cwd, "README.md"), "base\n");
  await mustRun(runner, "git", ["add", "README.md"], { cwd });
  await mustRun(runner, "git", ["commit", "-m", "base"], { cwd });
  return cwd;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function createReviewWorktree(
  cwd: string,
  worktree: string,
  suffix: string
): Promise<void> {
  await createNamedWorktree(cwd, worktree, `prtisan/review/pr-117-${suffix}`);
}

async function createNamedWorktree(
  cwd: string,
  worktree: string,
  branch: string
): Promise<void> {
  await mkdir(join(cwd, ".sandcastle", "worktrees"), { recursive: true });
  await mustRun(
    new BunCommandRunner(),
    "git",
    ["worktree", "add", "-b", branch, worktree, "main"],
    { cwd }
  );
}

async function registeredWorktrees(cwd: string): Promise<string[]> {
  const listed = await mustRun(
    new BunCommandRunner(),
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd }
  );
  return listed.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

class DisappearingWorktreeRunner implements CommandRunner {
  private readonly delegate = new BunCommandRunner();
  private disappeared = false;

  constructor(private readonly worktree: string) {}

  async run(
    command: string,
    args: readonly string[] = [],
    options: CommandOptions = {}
  ): Promise<CommandResult> {
    if (
      !this.disappeared &&
      command === "git" &&
      args[0] === "status" &&
      options.cwd === this.worktree
    ) {
      this.disappeared = true;
      await rm(this.worktree, { recursive: true, force: true });
    }
    return this.delegate.run(command, args, options);
  }
}
