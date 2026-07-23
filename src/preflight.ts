import type { CommandRunner } from "./exec.js";
import { mustRun } from "./exec.js";
import { resolvePath } from "./path.js";
import type { AgentTrainConfig } from "./types.js";

export async function assertPreflight(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
}): Promise<void> {
  if (!Bun.version) {
    throw new Error("agent-train must be run with Bun.");
  }

  await mustRun(input.runner, "git", ["--version"], { cwd: input.cwd });
  await mustRun(input.runner, "docker", ["--version"], { cwd: input.cwd });
  await mustRun(input.runner, "codex", ["--version"], { cwd: input.cwd });

  const codexHome = resolvePath(input.cwd, input.config.docker.codexHome);
  const codexHomeCheck = await input.runner.run("test", ["-d", codexHome], {
    cwd: input.cwd,
  });
  if (codexHomeCheck.exitCode !== 0) {
    throw new Error(
      `Dedicated CODEX_HOME is missing at ${codexHome}. Create it and seed Codex auth before running agents.`
    );
  }
}
