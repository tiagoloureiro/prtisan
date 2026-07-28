import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { managedDockerBuildLabels } from "./docker-ownership.js";
import type { CommandRunner } from "./exec.js";
import type { AgentTrainConfig } from "./types.js";

export interface ResolvedDockerImage {
  readonly id: string;
  readonly name: string;
}

export class DockerImagePreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerImagePreparationError";
  }
}

export class DockerBaseImageManager {
  private readonly preparations = new Map<
    string,
    Promise<ResolvedDockerImage>
  >();

  constructor(private readonly runner: CommandRunner) {}

  ensure(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly ref?: string;
  }): Promise<ResolvedDockerImage> {
    const key = [
      input.cwd,
      input.config.docker.imageName,
      input.config.docker.imagePolicy,
      input.ref ?? "",
      runtimeUid(),
      runtimeGid(),
    ].join("\0");
    const existing = this.preparations.get(key);
    if (existing) return existing;

    const preparation = this.prepare(input).catch((error) => {
      this.preparations.delete(key);
      throw error;
    });
    this.preparations.set(key, preparation);
    return preparation;
  }

  clear(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
  }): void {
    const prefix = `${input.cwd}\0${input.config.docker.imageName}\0${input.config.docker.imagePolicy}\0`;
    for (const key of this.preparations.keys()) {
      if (key.startsWith(prefix)) this.preparations.delete(key);
    }
  }

  private async prepare(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly ref?: string;
  }): Promise<ResolvedDockerImage> {
    return input.config.docker.imagePolicy === "managed"
      ? this.buildManaged(input)
      : this.inspectExternal(input);
  }

  private async buildManaged(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly ref?: string;
  }): Promise<ResolvedDockerImage> {
    const imageName = input.config.docker.imageName;
    const metadataDirectory = await mkdtemp(
      join(tmpdir(), "prtisan-base-image-")
    );
    const iidFile = join(metadataDirectory, "image.iid");
    const sourceDirectory = input.ref
      ? join(metadataDirectory, "source")
      : input.cwd;
    const buildReference = `prtisan.invalid/base-build:${randomUUID().replaceAll("-", "")}`;
    try {
      if (input.ref) {
        const worktree = await this.runner.run(
          "git",
          ["worktree", "add", "--detach", sourceDirectory, input.ref],
          { cwd: input.cwd }
        );
        if (worktree.exitCode !== 0) {
          throw new DockerImagePreparationError(
            `Unable to materialize frozen runtime ${input.ref}: ${trimOutput(
              worktree.stderr || worktree.stdout
            )}`
          );
        }
      }
      const build = await this.runner.run(
        "docker",
        [
          "build",
          "-t",
          imageName,
          "-t",
          buildReference,
          "--provenance=false",
          "--iidfile",
          iidFile,
          ...managedDockerBuildLabels("project-image", input.cwd),
          "--build-arg",
          `AGENT_UID=${runtimeUid()}`,
          "--build-arg",
          `AGENT_GID=${runtimeGid()}`,
          "-f",
          input.config.docker.dockerfile,
          input.config.docker.context,
        ],
        {
          cwd: sourceDirectory,
          timeoutMs: input.config.validation.maxWallTimeMs,
        }
      );
      if (build.exitCode !== 0) {
        throw new DockerImagePreparationError(
          `Unable to build managed Docker image ${imageName} from ${input.config.docker.dockerfile}: ${trimOutput(
            build.stderr || build.stdout
          )}`
        );
      }

      let imageId = "";
      try {
        imageId = (await readFile(iidFile, "utf8")).trim();
      } catch (error) {
        throw new DockerImagePreparationError(
          `Docker built managed image ${imageName} but did not write its image ID: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      const buildResultId = requireDockerImageId(
        imageId,
        "managed build result"
      );
      const inspect = await this.runner.run(
        "docker",
        ["image", "inspect", buildReference, "--format={{.Id}}"],
        {
          cwd: input.cwd,
          timeoutMs: input.config.validation.maxWallTimeMs,
        }
      );
      const localImageId = inspect.stdout.trim();
      if (inspect.exitCode !== 0 || !localImageId) {
        throw new DockerImagePreparationError(
          `Docker built managed image ${imageName} as ${buildResultId} but could not resolve its stable local image ID through ${buildReference}: ${trimOutput(
            inspect.stderr || inspect.stdout
          )}`
        );
      }
      return {
        id: requireDockerImageId(localImageId, "managed base"),
        name: imageName,
      };
    } finally {
      await this.runner.run("docker", ["image", "rm", buildReference], {
        cwd: input.cwd,
      });
      if (input.ref) {
        await this.runner.run(
          "git",
          ["worktree", "remove", "--force", sourceDirectory],
          { cwd: input.cwd }
        );
      }
      await rm(metadataDirectory, { recursive: true, force: true });
    }
  }

  private async inspectExternal(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly ref?: string;
  }): Promise<ResolvedDockerImage> {
    const imageName = input.config.docker.imageName;
    const inspect = await this.runner.run(
      "docker",
      ["image", "inspect", imageName, "--format={{.Id}}"],
      {
        cwd: input.cwd,
        timeoutMs: input.config.validation.maxWallTimeMs,
      }
    );
    const imageId = inspect.stdout.trim();
    if (inspect.exitCode !== 0 || !imageId) {
      throw new DockerImagePreparationError(
        `External Docker image ${imageName} is unavailable and will not be built because docker.imagePolicy is external: ${trimOutput(
          inspect.stderr || inspect.stdout
        )}`
      );
    }
    return {
      id: requireDockerImageId(imageId, "external base"),
      name: imageName,
    };
  }
}

export function requireDockerImageId(value: string, label: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new DockerImagePreparationError(
      `Docker returned an invalid ${label} image ID: ${value || "(empty)"}.`
    );
  }
  return value;
}

function trimOutput(value: string, maxChars = 2_000): string {
  const trimmed = value.trim();
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(-maxChars);
}

function runtimeUid(): number {
  return process.getuid?.() ?? 1000;
}

function runtimeGid(): number {
  return process.getgid?.() ?? 1000;
}
