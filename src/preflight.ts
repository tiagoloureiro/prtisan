import { randomUUID } from "node:crypto";

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

  const imageDiagnostic = await commandDiagnostic(
    input.runner,
    "Docker image",
    "docker",
    ["image", "inspect", input.config.docker.imageName],
    input.cwd
  );
  diagnostics.push(imageDiagnostic);
  if (imageDiagnostic.status === "ok") {
    diagnostics.push(
      await dockerImageDefaultCommandDiagnostic(
        input.runner,
        input.config,
        input.cwd
      )
    );
  }

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
  readonly log?: (message: string) => void;
}): Promise<void> {
  let diagnostics = await checkRuntimeReadiness(input);
  const imageDiagnostic = diagnostics.find(
    (item) => item.name === "Docker image"
  );
  if (isMissingDockerImageDiagnostic(imageDiagnostic)) {
    const buildDiagnostic = await buildDockerImage(input);
    diagnostics =
      buildDiagnostic.status === "ok"
        ? await checkRuntimeReadiness(input)
        : [...diagnostics, buildDiagnostic];
  }

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

async function buildDockerImage(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
  readonly log?: (message: string) => void;
}): Promise<RuntimeReadinessDiagnostic> {
  const imageName = input.config.docker.imageName;
  input.log?.(
    `Docker image ${imageName} is missing; building from .sandcastle/Dockerfile`
  );
  const result = await input.runner.run(
    "docker",
    [
      "build",
      "-t",
      imageName,
      "--build-arg",
      `AGENT_UID=${runtimeUid()}`,
      "--build-arg",
      `AGENT_GID=${runtimeGid()}`,
      "-f",
      ".sandcastle/Dockerfile",
      ".",
    ],
    { cwd: input.cwd }
  );

  return {
    name: "Docker image build",
    status: result.exitCode === 0 ? "ok" : "failed",
    details:
      result.exitCode === 0
        ? `Built ${imageName} from .sandcastle/Dockerfile.`
        : (result.stderr || result.stdout).trim() ||
          `docker build -t ${imageName} -f .sandcastle/Dockerfile . failed`,
  };
}

function isMissingDockerImageDiagnostic(
  diagnostic: RuntimeReadinessDiagnostic | undefined
): boolean {
  if (!diagnostic || diagnostic.status !== "failed") return false;
  return /no such image|not found/i.test(diagnostic.details ?? "");
}

async function dockerImageDefaultCommandDiagnostic(
  runner: CommandRunner,
  config: AgentTrainConfig,
  cwd: string
): Promise<RuntimeReadinessDiagnostic> {
  const containerName = `agent-train-preflight-${randomUUID()}`;
  const imageName = config.docker.imageName;
  const run = await runner.run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      containerName,
      "-e",
      "HOME=/home/agent",
      "--user",
      `${runtimeUid()}:${runtimeGid()}`,
      imageName,
    ],
    { cwd }
  );
  if (run.exitCode !== 0) {
    return {
      name: "Docker image default command",
      status: "failed",
      details:
        (run.stderr || run.stdout).trim() ||
        `docker run -d ${imageName} failed`,
    };
  }

  await waitForContainerExitRace();
  const inspect = await runner.run(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", containerName],
    { cwd }
  );

  if (inspect.exitCode === 0 && inspect.stdout.trim() === "true") {
    const gitConfig = await runner.run(
      "docker",
      [
        "exec",
        containerName,
        "git",
        "config",
        "--global",
        "--add",
        "safe.directory",
        "/home/agent/workspace",
      ],
      { cwd }
    );
    await runner.run("docker", ["rm", "-f", containerName], { cwd });
    if (gitConfig.exitCode !== 0) {
      return {
        name: "Docker image default command",
        status: "failed",
        details:
          (gitConfig.stderr || gitConfig.stdout).trim() ||
          "Docker image cannot write global Git config under /home/agent.",
      };
    }

    return {
      name: "Docker image default command",
      status: "ok",
      details: `${imageName} stays running and can write Git config under /home/agent.`,
    };
  }

  await runner.run("docker", ["rm", "-f", containerName], { cwd });

  return {
    name: "Docker image default command",
    status: "failed",
    details: [
      `${imageName} exits before Sandcastle can run docker exec.`,
      'Update the scaffolded Dockerfile to use CMD ["sleep", "infinity"], then rebuild the image.',
      (inspect.stderr || inspect.stdout).trim(),
    ]
      .filter(Boolean)
      .join(" "),
  };
}

async function waitForContainerExitRace(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function runtimeUid(): number {
  return process.getuid?.() ?? 1000;
}

function runtimeGid(): number {
  return process.getgid?.() ?? 1000;
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
