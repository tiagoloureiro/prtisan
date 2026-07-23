import type { CommandRunner } from "./exec.js";
import { joinPath, resolvePath } from "./path.js";
import type { AgentTrainConfig } from "./types.js";

export async function pruneTrainArtifacts(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
}): Promise<void> {
  const ttl = `+${input.config.retention.ttlDays}`;
  const maxLogSize = `+${input.config.retention.maxLogBytes}c`;
  const trainsRoot = joinPath(input.cwd, ".sandcastle", "trains");

  if (await directoryExists(input.runner, trainsRoot)) {
    await input.runner.run("find", [
      trainsRoot,
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
      trainsRoot,
      "-path",
      "*/logs/*",
      "-type",
      "f",
      "-mtime",
      ttl,
      "-delete",
    ]);
    await input.runner.run("find", [
      trainsRoot,
      "-path",
      "*/logs/*",
      "-type",
      "f",
      "-size",
      maxLogSize,
      "-delete",
    ]);
  }

  await input.runner.run("git", ["worktree", "prune"], { cwd: input.cwd });
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
    await input.runner.run("find", [
      path,
      "-type",
      "f",
      "-size",
      maxLogSize,
      "-delete",
    ]);
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
}

async function directoryExists(
  runner: CommandRunner,
  path: string
): Promise<boolean> {
  const result = await runner.run("test", ["-d", path]);
  return result.exitCode === 0;
}
