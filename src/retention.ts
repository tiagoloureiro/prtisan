import { open, stat, writeFile } from "node:fs/promises";

import type { CommandRunner } from "./exec.js";
import { joinPath, resolvePath } from "./path.js";
import type { AgentTrainConfig } from "./types.js";

export async function pruneRuntimeArtifacts(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
}): Promise<void> {
  const ttl = `+${input.config.retention.ttlDays}`;
  const maxLogSize = `+${input.config.retention.maxLogBytes}c`;
  const runsRoot = joinPath(input.cwd, ".sandcastle", "runs");

  if (await directoryExists(input.runner, runsRoot)) {
    await input.runner.run("find", [
      runsRoot,
      "-path",
      "*/worktrees/*",
      "-type",
      "d",
      "-mtime",
      ttl,
      "-prune",
      "-exec",
      "rm",
      "-rf",
      "{}",
      "+",
    ]);
    await input.runner.run("find", [
      runsRoot,
      "-path",
      "*/logs/*",
      "-type",
      "f",
      "-mtime",
      ttl,
      "-delete",
    ]);
    await retainBoundedLogTails(
      input.runner,
      runsRoot,
      input.config.retention.maxLogBytes
    );
    await enforceRunLimits(
      input.runner,
      runsRoot,
      input.config.retention.maxRuns,
      input.config.retention.maxTotalBytes
    );
  }

  await input.runner.run("git", ["worktree", "prune"], { cwd: input.cwd });
  await pruneReviewBranches(input.runner, input.cwd);
  for (const subdir of ["logs", "patches"]) {
    const path = joinPath(input.cwd, ".sandcastle", subdir);
    if (!(await directoryExists(input.runner, path))) continue;
    await input.runner.run("find", [
      path,
      "-type",
      "f",
      "-mtime",
      ttl,
      "-delete",
    ]);
    if (subdir === "logs") {
      await retainBoundedLogTails(
        input.runner,
        path,
        input.config.retention.maxLogBytes
      );
    } else {
      await input.runner.run("find", [
        path,
        "-type",
        "f",
        "-size",
        maxLogSize,
        "-delete",
      ]);
    }
  }

  const codexHome = resolvePath(input.cwd, input.config.docker.codexHome);
  for (const subdir of ["log", "sessions"]) {
    const path = joinPath(codexHome, subdir);
    if (!(await directoryExists(input.runner, path))) continue;
    await input.runner.run("find", [
      path,
      "-type",
      "f",
      "-mtime",
      ttl,
      "-delete",
    ]);
    await input.runner.run("find", [
      path,
      "-type",
      "f",
      "-size",
      maxLogSize,
      "-delete",
    ]);
  }

  for (const subdir of ["cache", "runtime"]) {
    const path = joinPath(input.cwd, ".sandcastle", subdir);
    if (!(await directoryExists(input.runner, path))) continue;
    await input.runner.run("find", [
      path,
      "-mindepth",
      "1",
      "-mtime",
      ttl,
      "-delete",
    ]);
  }
}

async function retainBoundedLogTails(
  runner: CommandRunner,
  root: string,
  maxBytes: number
): Promise<void> {
  const listed = await runner.run("find", [
    root,
    "-type",
    "f",
    "-size",
    `+${maxBytes}c`,
    "-print",
  ]);
  if (listed.exitCode !== 0) return;

  for (const path of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!path.startsWith(`${root}/`)) continue;
    try {
      const details = await stat(path);
      const length = Math.min(maxBytes, details.size);
      const buffer = Buffer.alloc(length);
      const handle = await open(path, "r");
      try {
        await handle.read(buffer, 0, length, details.size - length);
      } finally {
        await handle.close();
      }
      await writeFile(path, buffer, { mode: details.mode });
    } catch {
      // Retention races with normal cleanup; a vanished log needs no action.
    }
  }
}

async function enforceRunLimits(
  runner: CommandRunner,
  runsRoot: string,
  maxRuns: number,
  maxTotalBytes: number
): Promise<void> {
  const list = await runner.run("find", [
    runsRoot,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-type",
    "d",
    "-printf",
    "%T@ %p\n",
  ]);
  if (list.exitCode !== 0) return;
  const runs = list.stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = /^(\d+(?:\.\d+)?) (.+)$/.exec(line);
      return match?.[1] && match[2]
        ? { modifiedAt: Number(match[1]), path: match[2] }
        : undefined;
    })
    .filter((item): item is { modifiedAt: number; path: string } =>
      Boolean(item)
    )
    .sort((left, right) => left.modifiedAt - right.modifiedAt);

  while (
    runs.length > maxRuns ||
    (runs.length > 1 && (await directorySize(runner, runsRoot)) > maxTotalBytes)
  ) {
    const oldest = runs.shift();
    if (!oldest || !oldest.path.startsWith(`${runsRoot}/`)) break;
    await runner.run("rm", ["-rf", oldest.path]);
  }
}

async function directorySize(
  runner: CommandRunner,
  path: string
): Promise<number> {
  const result = await runner.run("du", ["-sb", path]);
  const value = Number(result.stdout.trim().split(/\s+/)[0]);
  return result.exitCode === 0 && Number.isFinite(value) ? value : 0;
}

async function pruneReviewBranches(
  runner: CommandRunner,
  cwd: string
): Promise<void> {
  const refs = await runner.run(
    "git",
    [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/agent-train/review",
    ],
    { cwd }
  );
  if (refs.exitCode !== 0) return;

  for (const branch of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!branch.startsWith("agent-train/review/")) continue;
    await runner.run("git", ["branch", "-D", branch], { cwd });
  }
}

async function directoryExists(
  runner: CommandRunner,
  path: string
): Promise<boolean> {
  const result = await runner.run("test", ["-d", path]);
  return result.exitCode === 0;
}
