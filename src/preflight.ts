import { randomUUID } from "node:crypto";

import {
  DockerBaseImageManager,
  type ResolvedDockerImage,
} from "./docker-image.js";
import type { CommandRunner } from "./exec.js";
import { ensureDir } from "./fs.js";
import type { GitHubClient } from "./github.js";
import { resolveCodexHome } from "./prtisan-paths.js";
import type { RuntimeProvider } from "./runtime.js";
import type { AgentTrainConfig } from "./types.js";

export type RuntimeReadinessStatus = "ok" | "failed";

export interface RuntimeReadinessDiagnostic {
  readonly name: string;
  readonly status: RuntimeReadinessStatus;
  readonly details?: string;
}

export type CodexAuthenticationReadiness =
  | {
      readonly kind: "ready";
      readonly codexHome: string;
    }
  | {
      readonly kind: "waiting";
      readonly codexHome: string;
      readonly loginCommand: string;
      readonly details: string;
    };

export async function checkCodexAuthentication(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
  readonly baseImages?: DockerBaseImageManager;
}): Promise<CodexAuthenticationReadiness> {
  const codexHome = resolveCodexHome(input.cwd, input.config.docker.codexHome);
  await ensureDir(codexHome);
  const loginCommand = codexLoginCommand(codexHome);
  const host = await input.runner.run("codex", ["login", "status"], {
    cwd: input.cwd,
    env: { CODEX_HOME: codexHome },
  });
  if (host.exitCode !== 0) {
    return {
      kind: "waiting",
      codexHome,
      loginCommand,
      details: "The dedicated Prtisan Codex profile is not authenticated.",
    };
  }

  const baseImages =
    input.baseImages ?? new DockerBaseImageManager(input.runner);
  const image = await baseImages.ensure({
    cwd: input.cwd,
    config: input.config,
    ref: `${input.config.remote}/${input.config.targetBranch}`,
  });
  const container = await input.runner.run(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      `${runtimeUid()}:${runtimeGid()}`,
      "-e",
      "HOME=/home/agent",
      "-e",
      "CODEX_HOME=/home/agent/.codex-prtisan",
      "-v",
      `${codexHome}:/home/agent/.codex-prtisan`,
      "--entrypoint",
      "codex",
      image.id,
      "login",
      "status",
    ],
    {
      cwd: input.cwd,
      timeoutMs: input.config.validation.maxWallTimeMs,
    }
  );
  if (container.exitCode !== 0) {
    return {
      kind: "waiting",
      codexHome,
      loginCommand,
      details:
        "The dedicated Prtisan Codex profile is not authenticated inside the managed runtime.",
    };
  }
  return { kind: "ready", codexHome };
}

export function codexLoginCommand(codexHome: string): string {
  return `CODEX_HOME=${shellQuote(codexHome)} codex login --device-auth`;
}

export async function checkRuntimeReadiness(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
  readonly github?: Pick<GitHubClient, "assertReady">;
  readonly runtime?: RuntimeProvider;
  readonly baseImage?: ResolvedDockerImage;
}): Promise<RuntimeReadinessDiagnostic[]> {
  const diagnostics: RuntimeReadinessDiagnostic[] = [];

  diagnostics.push({
    name: "Bun runtime",
    status: Bun.version ? "ok" : "failed",
    details: Bun.version
      ? `Bun ${Bun.version}`
      : "Prtisan must be run with Bun.",
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
    ["image", "inspect", input.baseImage?.id ?? input.config.docker.imageName],
    input.cwd
  );
  diagnostics.push(imageDiagnostic);
  if (imageDiagnostic.status === "ok") {
    diagnostics.push(
      await dockerImageDefaultCommandDiagnostic(
        input.runner,
        input.config,
        input.cwd,
        input.baseImage?.id
      )
    );
  }

  const codexHome = resolveCodexHome(input.cwd, input.config.docker.codexHome);
  const codexHomeCheck = await input.runner.run("codex", ["login", "status"], {
    cwd: input.cwd,
    env: { CODEX_HOME: codexHome },
  });
  diagnostics.push({
    name: "Dedicated CODEX_HOME",
    status: codexHomeCheck.exitCode === 0 ? "ok" : "failed",
    details:
      codexHomeCheck.exitCode === 0
        ? `${codexHome} (authenticated)`
        : `Shared CODEX_HOME is not authenticated at ${codexHome}. Run ${codexLoginCommand(codexHome)} once before running agents.`,
  });

  if (
    input.runtime &&
    imageDiagnostic.status === "ok" &&
    diagnostics.every((item) => item.status === "ok")
  ) {
    diagnostics.push(
      await targetRuntimeDiagnostic(input.runtime, input.cwd, input.config)
    );
  }

  return diagnostics;
}

export async function assertRuntimeReady(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
  readonly github?: Pick<GitHubClient, "assertReady">;
  readonly runtime?: RuntimeProvider;
  readonly baseImages?: DockerBaseImageManager;
  readonly log?: (message: string) => void;
}): Promise<void> {
  const diagnostics = await prepareRuntimeReadiness(input);
  const failed = diagnostics.filter((item) => item.status === "failed");
  if (failed.length === 0) return;
  throwReadinessError(failed);
}

export async function prepareRuntimeReadiness(input: {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly runner: CommandRunner;
  readonly github?: Pick<GitHubClient, "assertReady">;
  readonly runtime?: RuntimeProvider;
  readonly baseImages?: DockerBaseImageManager;
  readonly log?: (message: string) => void;
}): Promise<RuntimeReadinessDiagnostic[]> {
  const baseImages =
    input.baseImages ?? new DockerBaseImageManager(input.runner);
  const initialDiagnostics = await checkRuntimeReadiness({
    ...input,
    runtime: undefined,
  });
  let baseImage: ResolvedDockerImage;
  try {
    if (input.config.docker.imagePolicy === "managed") {
      input.log?.(
        `Building managed Docker image ${input.config.docker.imageName} from ${input.config.docker.dockerfile}`
      );
    }
    baseImage = await baseImages.ensure(input);
  } catch (error) {
    const failedImage = initialDiagnostics.find(
      (item) => item.name === "Docker image"
    );
    const imageFailure = {
      name:
        input.config.docker.imagePolicy === "managed"
          ? "Docker image build"
          : "Docker image",
      status: "failed" as const,
      details: dockerBuildFailureDetails(
        error instanceof Error ? error.message : String(error),
        input.config.docker.imageName,
        input.config.docker.dockerfile,
        input.config.docker.context
      ),
    };
    return [
      ...initialDiagnostics.filter(
        (item) =>
          item !== failedImage && item.name !== "Docker image default command"
      ),
      imageFailure,
    ];
  }

  return checkRuntimeReadiness({ ...input, baseImage });
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

function dockerBuildFailureDetails(
  output: string,
  imageName: string,
  dockerfile: string,
  context: string
): string {
  const details =
    output.trim() ||
    `docker build -t ${imageName} -f ${dockerfile} ${context} failed`;
  if (
    /groupadd: GID '\d+' already exists|useradd: UID \d+ is not unique/i.test(
      details
    )
  ) {
    return [
      details,
      "The scaffolded Dockerfile creates the agent user/group directly and is incompatible with host UID/GID build args. Refresh the target repository scaffold so the Dockerfile uses the current numeric USER form.",
    ].join("\n");
  }
  return details;
}

async function dockerImageDefaultCommandDiagnostic(
  runner: CommandRunner,
  config: AgentTrainConfig,
  cwd: string,
  resolvedImage?: string
): Promise<RuntimeReadinessDiagnostic> {
  const containerName = `prtisan-preflight-${randomUUID()}`;
  const imageName = resolvedImage ?? config.docker.imageName;
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

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
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

async function targetRuntimeDiagnostic(
  runtime: RuntimeProvider,
  cwd: string,
  config: AgentTrainConfig
): Promise<RuntimeReadinessDiagnostic> {
  try {
    const prepared = await runtime.prepare({
      cwd,
      ref: config.targetBranch,
      config,
    });
    return {
      name: "Target runtime",
      status: "ok",
      details: `${prepared.imageName} (${prepared.fingerprint.slice(0, 12)}) with ${prepared.verification.length} verification command(s).`,
    };
  } catch (error) {
    return {
      name: "Target runtime",
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

function throwReadinessError(
  failed: readonly RuntimeReadinessDiagnostic[]
): never {
  throw new Error(
    [
      "Runtime readiness failed:",
      ...failed.map(
        (item) => `- ${item.name}: ${item.details ?? "check failed"}`
      ),
    ].join("\n")
  );
}
