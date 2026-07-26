import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { CommandOptions, CommandResult, CommandRunner } from "@/exec.js";
import {
  DockerRuntimeImageBuilder,
  DockerVerificationRunner,
  ManifestToolchainResolver,
  type PreparedRuntime,
} from "@/runtime.js";

import { testConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("target runtime resolution", () => {
  test("discovers exact Node and pnpm pins and selects safe checks", async () => {
    const cwd = await temporaryDirectory();
    const runner = new SnapshotRunner({
      "package.json": JSON.stringify({
        packageManager: "pnpm@10.14.0",
        engines: { node: ">=22.18.0" },
        scripts: {
          check: "run-s lint typecheck",
          "format:check": "prettier --check .",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          test: "vitest",
          build: "vite build",
          e2e: "playwright test",
          deploy: "deploy",
        },
      }),
      ".nvmrc": "22.18.0\n",
      ".tool-versions": "node 22.18.0\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const profile = await new ManifestToolchainResolver(runner).resolve({
      cwd,
      ref: "head",
      config: testConfig(),
    });

    expect(profile).toMatchObject({
      kind: "node",
      nodeVersion: "22.18.0",
      packageManager: "pnpm",
      packageManagerVersion: "10.14.0",
    });
    expect(profile.verification.map((item) => item.command)).toEqual([
      "pnpm check",
      "pnpm test",
      "pnpm build",
    ]);
    expect(profile.verification.map((item) => item.command)).not.toContain(
      "pnpm e2e"
    );
    expect(profile.probes[0]?.command).toContain('test "$actual" = "v22.18.0"');
    expect(profile.probes[1]?.command).toContain('test "$actual" = "10.14.0"');
  });

  test("fails closed on contradictory or non-exact declarations", async () => {
    const cwd = await temporaryDirectory();
    const resolver = new ManifestToolchainResolver(
      new SnapshotRunner({
        "package.json": JSON.stringify({
          packageManager: "pnpm@10.14.0",
          scripts: { check: "pnpm lint" },
        }),
        ".nvmrc": "22.18.0\n",
        ".node-version": "20.19.0\n",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      })
    );

    await expect(
      resolver.resolve({
        cwd,
        ref: "head",
        config: testConfig(),
      })
    ).rejects.toThrow("Conflicting Node versions");

    const nonExact = new ManifestToolchainResolver(
      new SnapshotRunner({
        "package.json": JSON.stringify({
          packageManager: "pnpm@10",
          scripts: { check: "pnpm lint" },
        }),
        ".nvmrc": "22.18.0\n",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      })
    );
    await expect(
      nonExact.resolve({
        cwd,
        ref: "head",
        config: testConfig(),
      })
    ).rejects.toThrow("packageManager must pin an exact supported version");

    const incompatibleEngine = new ManifestToolchainResolver(
      new SnapshotRunner({
        "package.json": JSON.stringify({
          packageManager: "pnpm@10.14.0",
          engines: { node: ">=20.0.0 <22.0.0" },
          scripts: { check: "pnpm lint" },
        }),
        ".nvmrc": "22.18.0\n",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      })
    );
    await expect(
      incompatibleEngine.resolve({
        cwd,
        ref: "head",
        config: testConfig(),
      })
    ).rejects.toThrow("does not satisfy engines.node");
  });

  test("fails closed on conflicting lockfiles", async () => {
    const cwd = await temporaryDirectory();
    const resolver = new ManifestToolchainResolver(
      new SnapshotRunner({
        "package.json": JSON.stringify({
          packageManager: "pnpm@10.14.0",
          scripts: { check: "pnpm lint" },
        }),
        ".nvmrc": "22.18.0\n",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "package-lock.json": "{}\n",
      })
    );

    await expect(
      resolver.resolve({
        cwd,
        ref: "head",
        config: testConfig(),
      })
    ).rejects.toThrow("conflicting lockfile");
  });

  test("requires explicit probes and verification for unsupported stacks", async () => {
    const cwd = await temporaryDirectory();
    const resolver = new ManifestToolchainResolver(new SnapshotRunner({}));

    await expect(
      resolver.resolve({
        cwd,
        ref: "head",
        config: testConfig(),
      })
    ).rejects.toThrow(
      "Unsupported runtime stacks require explicit sandbox probes and verification commands"
    );
  });

  test("keys derivative images by base image ID and pulls exact toolchain stages", async () => {
    const cwd = await temporaryDirectory();
    const runner = new RuntimeRunner([
      commandResult(0, "sha256:base-image-a\n"),
      commandResult(0),
      commandResult(0, "sha256:node-image-a\n"),
      commandResult(0),
      commandResult(0, "sha256:tools-image-a\n"),
      commandResult(1, "", "missing derivative"),
      commandResult(0),
    ]);
    const profile = {
      kind: "node" as const,
      nodeVersion: "22.18.0",
      packageManager: "pnpm" as const,
      packageManagerVersion: "10.14.0",
      lockfileDigest: "lock-digest",
      bootstrap: {
        name: "Install",
        command: "pnpm install --frozen-lockfile",
        timeoutMs: 60_000,
      },
      verification: [
        {
          name: "Check",
          command: "pnpm check",
          timeoutMs: 60_000,
        },
      ],
      probes: [],
      fingerprint: "toolchain-digest",
    };

    const image = await new DockerRuntimeImageBuilder(runner).ensureImage({
      cwd,
      config: testConfig(),
      profile,
    });

    expect(image).toMatch(/^agent-train\/runtime:[a-f0-9]{20}$/);
    const build = runner.calls.find(
      (call) => call.command === "docker" && call.args[0] === "build"
    );
    expect(build?.args).not.toContain("--pull");
    expect(build?.args).toContain("BASE_IMAGE=sha256:base-image-a");
    expect(build?.args).toContain("TOOLCHAIN_IMAGE=sha256:node-image-a");
    expect(build?.args).toContain("TOOLS_IMAGE=sha256:tools-image-a");
    expect(
      runner.calls.some(
        (call) =>
          call.command === "docker" &&
          call.args[0] === "pull" &&
          call.args[1] === "node:22.18.0-bookworm-slim"
      )
    ).toBe(true);
  });
});

describe("host verification", () => {
  test("classifies bootstrap failure as infrastructure and stops", async () => {
    const cwd = await temporaryDirectory();
    const runner = new RuntimeRunner([
      commandResult(127, "", "pnpm: command not found"),
    ]);
    const result = await new DockerVerificationRunner(runner).verify({
      cwd,
      runId: "runtime-test",
      label: "missing-pnpm",
      ref: "repair-sha",
      config: testConfig(),
      runtime: preparedRuntime(),
    });

    expect(result.status).toBe("infra_failed");
    expect(result.commands).toHaveLength(1);
    expect(
      runner.calls.filter((call) => call.command === "docker")
    ).toHaveLength(1);
  });

  test("treats timeouts and signals as infrastructure failures", async () => {
    const cwd = await temporaryDirectory();
    const runner = new RuntimeRunner([
      commandResult(0),
      {
        ...commandResult(124, "", "terminated"),
        timedOut: true,
      },
    ]);
    const result = await new DockerVerificationRunner(runner).verify({
      cwd,
      runId: "runtime-test",
      label: "timeout",
      ref: "repair-sha",
      config: testConfig(),
      runtime: preparedRuntime(),
    });

    expect(result.status).toBe("infra_failed");
    expect(result.commands[1]).toMatchObject({
      name: "Project check",
      timedOut: true,
      exitCode: 124,
    });
  });

  test("shares one absolute deadline across bootstrap and verification", async () => {
    const cwd = await temporaryDirectory();
    let now = 1_000;
    const runner = new RuntimeRunner(
      [commandResult(0), commandResult(0)],
      (call) => {
        if (call.command === "docker" && call.args[0] === "run") {
          now += 700;
        }
      }
    );
    const config = {
      ...testConfig(),
      validation: {
        ...testConfig().validation,
        maxWallTimeMs: 1_000,
      },
    };
    const runtime = preparedRuntime();
    const result = await new DockerVerificationRunner(runner, () => now).verify(
      {
        cwd,
        runId: "runtime-test",
        label: "absolute-deadline",
        ref: "repair-sha",
        config,
        runtime: {
          ...runtime,
          bootstrap: {
            ...runtime.bootstrap!,
            timeoutMs: 900,
          },
          verification: [
            {
              ...runtime.verification[0]!,
              timeoutMs: 900,
            },
          ],
        },
      }
    );

    expect(result.status).toBe("passed");
    expect(
      runner.calls
        .filter((call) => call.command === "docker" && call.args[0] === "run")
        .map((call) => call.timeoutMs)
    ).toEqual([900, 300]);
  });
});

class SnapshotRunner implements CommandRunner {
  constructor(private readonly files: Readonly<Record<string, string>>) {}

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    const spec = args[1];
    const path =
      command === "git" && args[0] === "show"
        ? spec?.slice((spec.indexOf(":") ?? -1) + 1)
        : undefined;
    const contents = path ? this.files[path] : undefined;
    return {
      command: [command, ...args],
      cwd: options?.cwd,
      stdout: contents ?? "",
      stderr: contents === undefined ? "missing" : "",
      exitCode: contents === undefined ? 1 : 0,
    };
  }
}

class RuntimeRunner implements CommandRunner {
  readonly calls: {
    readonly command: string;
    readonly args: readonly string[];
    readonly timeoutMs?: number;
  }[] = [];

  constructor(
    private readonly dockerResults: CommandResult[],
    private readonly onCall?: (call: {
      readonly command: string;
      readonly args: readonly string[];
      readonly timeoutMs?: number;
    }) => void
  ) {}

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    const call = { command, args, timeoutMs: options?.timeoutMs };
    this.calls.push(call);
    this.onCall?.(call);
    const result =
      command === "docker"
        ? (this.dockerResults.shift() ?? commandResult(0))
        : commandResult(0);
    return {
      ...result,
      command: [command, ...args],
      cwd: options?.cwd,
    };
  }
}

function preparedRuntime(): PreparedRuntime {
  const bootstrap = {
    name: "Install dependencies",
    command: "pnpm install --frozen-lockfile",
    timeoutMs: 60_000,
  };
  const verification = [
    {
      name: "Project check",
      command: "pnpm check",
      timeoutMs: 60_000,
    },
  ];
  return {
    imageName: "runtime:test",
    fingerprint: "runtime-fingerprint",
    profile: {
      kind: "node",
      nodeVersion: "22.18.0",
      packageManager: "pnpm",
      packageManagerVersion: "10.14.0",
      bootstrap,
      verification,
      probes: [],
      fingerprint: "profile-fingerprint",
    },
    bootstrap,
    verification,
    probes: [],
  };
}

function commandResult(
  exitCode: number,
  stdout = "",
  stderr = ""
): CommandResult {
  return {
    command: [],
    stdout,
    stderr,
    exitCode,
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "prtisan-runtime-test-"));
  temporaryDirectories.push(path);
  return path;
}
