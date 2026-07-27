import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  DockerBaseImageManager,
  type ResolvedDockerImage,
} from "@/docker-image.js";
import type { CommandOptions, CommandResult, CommandRunner } from "@/exec.js";
import { DeclaredRuntimeProvider } from "@/runtime.js";

import { testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("Docker base image lifecycle", () => {
  test("builds a managed image once and shares its exact image ID", async () => {
    const cwd = await temporaryDirectory();
    const buildResultId =
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const imageId =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const runner = new ManagedImageRunner(buildResultId, imageId);
    const manager = new DockerBaseImageManager(runner);
    const config = testConfig();

    const [left, right] = await Promise.all([
      manager.ensure({ cwd, config }),
      manager.ensure({ cwd, config }),
    ]);

    expect(left).toEqual({
      id: imageId,
      name: config.docker.imageName,
    } satisfies ResolvedDockerImage);
    expect(right).toEqual(left);
    expect(
      runner.calls.filter(
        (call) => call.command === "docker" && call.args[0] === "build"
      )
    ).toHaveLength(1);
    expect(
      runner.calls.find(
        (call) => call.command === "docker" && call.args[0] === "build"
      )?.args
    ).toContain("--iidfile");
    expect(
      runner.calls.find(
        (call) => call.command === "docker" && call.args[0] === "build"
      )?.args
    ).toContain("--provenance=false");
  });

  test("rebuilds a managed image after its cached resolution is cleared", async () => {
    const cwd = await temporaryDirectory();
    const imageId =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const runner = new ManagedImageRunner(imageId);
    const manager = new DockerBaseImageManager(runner);
    const config = testConfig();

    await manager.ensure({ cwd, config });
    manager.clear({ cwd, config });
    await manager.ensure({ cwd, config });

    expect(
      runner.calls.filter(
        (call) => call.command === "docker" && call.args[0] === "build"
      )
    ).toHaveLength(2);
  });

  test("does not build an unavailable external image", async () => {
    const cwd = await temporaryDirectory();
    const runner = new MissingExternalImageRunner();
    const manager = new DockerBaseImageManager(runner);
    const config = testConfig({
      docker: {
        ...testConfig().docker,
        imageName: "registry.example.test/team/runtime:stable",
        imagePolicy: "external",
      },
    });

    await expect(manager.ensure({ cwd, config })).rejects.toThrow(
      "will not be built because docker.imagePolicy is external"
    );
    expect(
      runner.calls.some(
        (call) => call.command === "docker" && call.args[0] === "build"
      )
    ).toBe(false);
  });

  test("rejects an invalid Docker image ID", async () => {
    const cwd = await temporaryDirectory();
    const runner = new ManagedImageRunner("sha256:not-an-image-id");
    const manager = new DockerBaseImageManager(runner);

    await expect(manager.ensure({ cwd, config: testConfig() })).rejects.toThrow(
      "invalid managed build result image ID"
    );
  });

  test("builds reviewed runtime policy when a PR predates setup", async () => {
    const cwd = await temporaryDirectory();
    const imageId =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const runner = new HistoricalRuntimeRunner(imageId);
    const defaults = testConfig();
    const config = testConfig({
      runtime: {
        ...defaults.runtime,
        verificationMode: "explicit",
        verification: [
          { name: "Check", command: "bun test", timeoutMs: 60_000 },
        ],
      },
    });
    const provider = new DeclaredRuntimeProvider(
      new DockerBaseImageManager(runner)
    );

    const runtime = await provider.prepare({
      cwd,
      ref: "before-setup-head",
      config,
    });

    expect(runtime.imageName).toBe(imageId);
  });
});

class ManagedImageRunner implements CommandRunner {
  readonly calls: {
    readonly command: string;
    readonly args: readonly string[];
  }[] = [];

  constructor(
    private readonly buildResultId: string,
    private readonly inspectedImageId = buildResultId
  ) {}

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    this.calls.push({ command, args });
    let stdout = "";
    if (command === "docker" && args[0] === "build") {
      const iidFile = args[args.indexOf("--iidfile") + 1];
      if (iidFile) {
        await mkdir(join(iidFile, ".."), { recursive: true }).catch(() => {});
        await writeFile(iidFile, `${this.buildResultId}\n`);
      }
    } else if (
      command === "docker" &&
      args[0] === "image" &&
      args[1] === "inspect"
    ) {
      stdout = `${this.inspectedImageId}\n`;
    }
    return {
      command: [command, ...args],
      cwd: options?.cwd,
      stdout,
      stderr: "",
      exitCode: 0,
    };
  }
}

class MissingExternalImageRunner implements CommandRunner {
  readonly calls: {
    readonly command: string;
    readonly args: readonly string[];
  }[] = [];

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    this.calls.push({ command, args });
    return {
      command: [command, ...args],
      cwd: options?.cwd,
      stdout: "",
      stderr: "Error response from daemon: No such image",
      exitCode: 1,
    };
  }
}

class HistoricalRuntimeRunner implements CommandRunner {
  constructor(private readonly imageId: string) {}

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    if (command === "git" && args[0] === "worktree" && args[1] === "add") {
      const sourceDirectory = args[3];
      const ref = args[4];
      if (sourceDirectory) {
        await mkdir(sourceDirectory, { recursive: true });
        if (ref === "origin/main") {
          await mkdir(join(sourceDirectory, ".prtisan"), { recursive: true });
          await writeFile(
            join(sourceDirectory, ".prtisan", "Dockerfile"),
            "FROM scratch\n"
          );
        }
      }
      return commandResult(command, args, options);
    }
    if (command === "docker" && args[0] === "build") {
      const dockerfile = args[args.indexOf("-f") + 1];
      try {
        await access(join(options?.cwd ?? "", dockerfile ?? ""));
      } catch {
        return commandResult(
          command,
          args,
          options,
          "",
          1,
          "resolve : lstat .prtisan: no such file or directory"
        );
      }
      const iidFile = args[args.indexOf("--iidfile") + 1];
      if (iidFile) await writeFile(iidFile, `${this.imageId}\n`);
      return commandResult(command, args, options);
    }
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
      return commandResult(command, args, options, `${this.imageId}\n`);
    }
    return commandResult(command, args, options);
  }
}

function commandResult(
  command: string,
  args: readonly string[],
  options?: CommandOptions,
  stdout = "",
  exitCode = 0,
  stderr = ""
): CommandResult {
  return {
    command: [command, ...args],
    cwd: options?.cwd,
    stdout,
    stderr,
    exitCode,
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "prtisan-docker-image-test-"));
  temporaryDirectories.push(path);
  return path;
}
