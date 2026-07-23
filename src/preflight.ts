import type { CommandRunner } from "./exec.js";
import type { GitHubClient } from "./github.js";
import { resolvePath } from "./path.js";
import type { AgentTrainConfig } from "./types.js";

export type RuntimeReadinessStatus = "ok" | "failed";

export interface RuntimeReadinessDiagnostic {
  readonly name: string;
  readonly status: RuntimeReadinessStatus;
  readonly details?: string;
}

export async function checkRuntimeReadiness(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
  readonly github?: Pick<GitHubClient, "assertReady">;
}): Promise<RuntimeReadinessDiagnostic[]> {
  const diagnostics: RuntimeReadinessDiagnostic[] = [];

  diagnostics.push({
    name: "Bun runtime",
    status: Bun.version ? "ok" : "failed",
    details: Bun.version
      ? `Bun ${Bun.version}`
      : "agent-train must be run with Bun.",
  });

  diagnostics.push(
    await commandDiagnostic(
      input.runner,
      "Git",
      "git",
      ["--version"],
      input.cwd
    )
  );
  diagnostics.push(
    await commandDiagnostic(
      input.runner,
      "Docker",
      "docker",
      ["--version"],
      input.cwd
    )
  );
  diagnostics.push(
    await commandDiagnostic(
      input.runner,
      "Codex CLI",
      "codex",
      ["--version"],
      input.cwd
    )
  );

  if (input.github) {
    diagnostics.push(await githubDiagnostic(input.github));
  }

  diagnostics.push(
    await commandDiagnostic(
      input.runner,
      "Docker image",
      "docker",
      ["image", "inspect", input.config.docker.imageName],
      input.cwd
    )
  );

  const codexHome = resolvePath(input.cwd, input.config.docker.codexHome);
  const codexHomeCheck = await input.runner.run("test", ["-d", codexHome], {
    cwd: input.cwd,
  });
  diagnostics.push({
    name: "Dedicated CODEX_HOME",
    status: codexHomeCheck.exitCode === 0 ? "ok" : "failed",
    details:
      codexHomeCheck.exitCode === 0
        ? codexHome
        : `Dedicated CODEX_HOME is missing at ${codexHome}. Create it and seed Codex auth before running agents.`,
  });

  return diagnostics;
}

export async function assertRuntimeReady(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
  readonly github?: Pick<GitHubClient, "assertReady">;
}): Promise<void> {
  const diagnostics = await checkRuntimeReadiness(input);
  const failed = diagnostics.filter((item) => item.status === "failed");
  if (failed.length === 0) return;

  throw new Error(
    [
      "Runtime readiness failed:",
      ...failed.map(
        (item) => `- ${item.name}: ${item.details ?? "check failed"}`
      ),
    ].join("\n")
  );
}

export async function assertPreflight(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
}): Promise<void> {
  await assertRuntimeReady(input);
}

async function commandDiagnostic(
  runner: CommandRunner,
  name: string,
  command: string,
  args: readonly string[],
  cwd: string
): Promise<RuntimeReadinessDiagnostic> {
  const result = await runner.run(command, args, { cwd });
  return {
    name,
    status: result.exitCode === 0 ? "ok" : "failed",
    details:
      result.exitCode === 0
        ? firstLine(result.stdout || result.stderr)
        : (result.stderr || result.stdout).trim() ||
          `${command} ${args.join(" ")} failed`,
  };
}

async function githubDiagnostic(
  github: Pick<GitHubClient, "assertReady">
): Promise<RuntimeReadinessDiagnostic> {
  try {
    await github.assertReady();
    return {
      name: "GitHub CLI",
      status: "ok",
    };
  } catch (error) {
    return {
      name: "GitHub CLI",
      status: "failed",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

function firstLine(value: string): string | undefined {
  return value
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
}
