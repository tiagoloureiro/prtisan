import { rm, stat } from "node:fs/promises";

import type { CommandRunner } from "./exec.js";
import { CommandSpawnError } from "./exec.js";
import { joinPath, resolvePath } from "./path.js";

const MANAGED_WORKTREE_PATTERNS = [
  {
    pathPrefix: "prtisan-review-",
    branchPrefix: "refs/heads/prtisan/review/",
  },
  {
    pathPrefix: "prtisan-repair-",
    branchPrefix: "refs/heads/prtisan/repair/",
  },
  {
    pathPrefix: "agent-train-review-",
    branchPrefix: "refs/heads/agent-train/review/",
  },
  {
    pathPrefix: "agent-train-repair-",
    branchPrefix: "refs/heads/agent-train/repair/",
  },
] as const;
const GENERATED_CACHE_ROOTS = [".pnpm-store"] as const;

export interface PrtisanWorktreeCleanupResult {
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
  readonly skipped: readonly string[];
}

export async function reconcilePrtisanWorktrees(
  runner: CommandRunner,
  cwd: string
): Promise<PrtisanWorktreeCleanupResult> {
  await pruneWorktreeRegistry(runner, cwd);

  const removed = new Set<string>();
  const preserved = new Set<string>();
  const skipped = new Set<string>();
  let disappearanceRetries = 0;

  for (;;) {
    const pass = await reconcileRegisteredWorktrees(runner, cwd, {
      removed,
      preserved,
      skipped,
    });
    if (!pass.retry) {
      return {
        removed: [...removed],
        preserved: [...preserved],
        skipped: [...skipped],
      };
    }
    if (disappearanceRetries >= 1) {
      skipped.add(pass.path);
      return {
        removed: [...removed],
        preserved: [...preserved],
        skipped: [...skipped],
      };
    }
    disappearanceRetries += 1;
    await pruneWorktreeRegistry(runner, cwd);
  }
}

async function reconcileRegisteredWorktrees(
  runner: CommandRunner,
  cwd: string,
  result: {
    readonly removed: Set<string>;
    readonly preserved: Set<string>;
    readonly skipped: Set<string>;
  }
): Promise<{ readonly retry: false } | { readonly retry: true; path: string }> {
  const listed = await runner.run("git", ["worktree", "list", "--porcelain"], {
    cwd,
  });
  if (listed.exitCode !== 0) {
    throw new Error(
      `Unable to inspect Prtisan review worktrees: ${
        listed.stderr || listed.stdout
      }`
    );
  }

  const root = resolvePath(cwd, ".sandcastle/worktrees");
  for (const worktree of parseWorktrees(listed.stdout)) {
    if (!isManagedPrtisanWorktree(worktree, root)) continue;
    const status = await inspectWorktreeStatus(runner, worktree.path);
    if (status.kind === "missing") {
      if (worktree.locked) {
        result.skipped.add(worktree.path);
        continue;
      }
      return { retry: true, path: worktree.path };
    }
    if (
      status.paths.length === 0 ||
      !status.paths.every((path) => isGeneratedCachePath(path))
    ) {
      if (status.paths.length > 0) result.preserved.add(worktree.path);
      continue;
    }

    for (const cacheRoot of GENERATED_CACHE_ROOTS) {
      if (
        status.paths.some(
          (path) => path === cacheRoot || path.startsWith(`${cacheRoot}/`)
        )
      ) {
        await rm(joinPath(worktree.path, cacheRoot), {
          recursive: true,
          force: true,
        });
      }
    }
    const afterCacheRemoval = await inspectWorktreeStatus(
      runner,
      worktree.path
    );
    if (afterCacheRemoval.kind === "missing") {
      return { retry: true, path: worktree.path };
    }
    if (afterCacheRemoval.paths.length > 0) {
      result.preserved.add(worktree.path);
      continue;
    }

    const removal = await runner.run(
      "git",
      ["worktree", "remove", worktree.path],
      { cwd }
    );
    if (removal.exitCode !== 0) {
      result.preserved.add(worktree.path);
      continue;
    }
    const branch = worktree.branch?.slice("refs/heads/".length);
    if (branch) {
      await runner.run("git", ["branch", "-D", branch], { cwd });
    }
    result.removed.add(worktree.path);
  }

  return { retry: false };
}

interface WorktreeRecord {
  readonly path: string;
  readonly branch?: string;
  readonly locked: boolean;
}

function parseWorktrees(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  let locked = false;
  const flush = () => {
    if (path) records.push({ path, branch, locked });
    path = undefined;
    branch = undefined;
    locked = false;
  };

  for (const line of `${output}\n`.split(/\r?\n/)) {
    if (!line) {
      flush();
    } else if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length);
    } else if (line === "locked" || line.startsWith("locked ")) {
      locked = true;
    }
  }
  return records;
}

function isManagedPrtisanWorktree(
  worktree: WorktreeRecord,
  root: string
): boolean {
  return (
    worktree.path.startsWith(`${root}/`) &&
    MANAGED_WORKTREE_PATTERNS.some(
      (pattern) =>
        worktree.path.slice(root.length + 1).startsWith(pattern.pathPrefix) &&
        worktree.branch?.startsWith(pattern.branchPrefix) === true
    )
  );
}

async function inspectWorktreeStatus(
  runner: CommandRunner,
  worktreePath: string
): Promise<
  | { readonly kind: "ready"; readonly paths: readonly string[] }
  | {
      readonly kind: "missing";
    }
> {
  if (!(await directoryExists(worktreePath))) return { kind: "missing" };
  try {
    const result = await runner.run(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: worktreePath }
    );
    if (result.exitCode !== 0) {
      return { kind: "ready", paths: ["<unreadable>"] };
    }
    return {
      kind: "ready",
      paths: result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.slice(3).trim()),
    };
  } catch (error) {
    if (error instanceof CommandSpawnError && error.reason === "missing_cwd") {
      return { kind: "missing" };
    }
    throw error;
  }
}

function isGeneratedCachePath(path: string): boolean {
  return GENERATED_CACHE_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`)
  );
}

async function pruneWorktreeRegistry(
  runner: CommandRunner,
  cwd: string
): Promise<void> {
  const pruned = await runner.run(
    "git",
    ["worktree", "prune", "--expire", "now"],
    { cwd }
  );
  if (pruned.exitCode !== 0) {
    throw new Error(
      `Unable to reconcile stale Git worktree metadata: ${
        pruned.stderr || pruned.stdout
      }`
    );
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
