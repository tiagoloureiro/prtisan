import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { CommandOptions, CommandResult, CommandRunner } from "@/exec.js";
import {
  DeclaredRuntimeProvider,
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
  test("mounts a repository-scoped pnpm store for declared bootstrap commands", async () => {
    const cwd = await temporaryDirectory();
    const imageId = `sha256:${"a".repeat(64)}`;
    const provider = new DeclaredRuntimeProvider({
      ensure: async () => ({ id: imageId, name: "prtisan:repository" }),
    } as never);
    const config = testConfig({
      runtime: {
        ...testConfig().runtime,
        verificationMode: "explicit",
        bootstrap: {
          name: "Install dependencies",
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
      },
    });

    const runtime = await provider.prepare({ cwd, ref: "head", config });

    expect(runtime.cacheMount).toMatchObject({
      sandboxPath: "/home/agent/.local/share/pnpm/store",
    });
    expect(runtime.cacheMount?.hostPath).not.toContain(cwd);
    expect(runtime.bootstrap?.command).toBe(
      "pnpm install --frozen-lockfile --store-dir /home/agent/.local/share/pnpm/store"
    );
  });

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
    expect(profile.bootstrap?.command).toBe(
      "pnpm install --frozen-lockfile --store-dir /home/agent/.local/share/pnpm/store"
    );
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

  test("discovers pinned Python, Go, and Rust runtimes", async () => {
    const cwd = await temporaryDirectory();
    const cases = [
      {
        files: {
          "pyproject.toml":
            '[project]\nrequires-python = "==3.12.4"\ndependencies = ["pytest"]\n',
          "uv.lock": "version = 1\n",
          ".python-version": "3.12.4\n",
        },
        expected: {
          kind: "python",
          languageVersion: "3.12.4",
          packageManager: "uv",
          bootstrap: "uv sync --frozen",
          verification: "uv run pytest",
        },
      },
      {
        files: {
          "go.mod": "module example.test/app\n\ngo 1.24.0\n",
        },
        expected: {
          kind: "go",
          languageVersion: "1.24.0",
          packageManager: "go",
          bootstrap: "go mod download",
          verification: "go test ./...",
        },
      },
      {
        files: {
          "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\n',
          "Cargo.lock": "version = 4\n",
          "rust-toolchain.toml":
            '[toolchain]\nchannel = "1.88.0"\ncomponents = ["clippy"]\n',
        },
        expected: {
          kind: "rust",
          languageVersion: "1.88.0",
          packageManager: "cargo",
          bootstrap: "cargo fetch --locked",
          verification: "cargo test --locked",
        },
      },
    ] as const;

    for (const item of cases) {
      const profile = await new ManifestToolchainResolver(
        new SnapshotRunner(item.files)
      ).resolve({
        cwd,
        ref: "head",
        config: testConfig(),
      });
      expect(profile).toMatchObject({
        kind: item.expected.kind,
        languageVersion: item.expected.languageVersion,
        packageManager: item.expected.packageManager,
      });
      expect(profile.bootstrap?.command).toContain(item.expected.bootstrap);
      expect(
        profile.verification.some((command) =>
          command.command.includes(item.expected.verification)
        )
      ).toBe(true);
    }
  });

  test("fails closed when multiple language roots require an explicit composed runtime", async () => {
    const cwd = await temporaryDirectory();
    await expect(
      new ManifestToolchainResolver(
        new SnapshotRunner({
          "pyproject.toml":
            '[project]\nrequires-python = "==3.12.4"\ndependencies = ["pytest"]\n',
          "uv.lock": "version = 1\n",
          ".python-version": "3.12.4\n",
          "go.mod": "module example.test/app\n\ngo 1.24.0\n",
        })
      ).resolve({ cwd, ref: "head", config: testConfig() })
    ).rejects.toThrow("Detected a polyglot repository");
  });

  test("keys derivative images by source IDs without using raw IDs as Dockerfile references", async () => {
    const cwd = await temporaryDirectory();
    const baseImageId =
      "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const toolchainImageId =
      "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const toolsImageId =
      "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const config = testConfig({
      docker: {
        ...testConfig().docker,
        imagePolicy: "external",
      },
    });
    const runner = new RuntimeRunner([
      commandResult(0, `${baseImageId}\n`),
      commandResult(0),
      commandResult(0, `${toolchainImageId}\n`),
      commandResult(0),
      commandResult(0, `${toolsImageId}\n`),
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
      config,
      profile,
    });

    expect(image).toMatch(/^prtisan\/runtime:[a-f0-9]{20}$/);
    const build = runner.calls.find(
      (call) => call.command === "docker" && call.args[0] === "build"
    );
    expect(build?.args).not.toContain("--pull");
    expect(
      build?.args.some((arg) =>
        /^(?:BASE_IMAGE|TOOLCHAIN_IMAGE|TOOLS_IMAGE)=sha256:/.test(arg)
      )
    ).toBe(false);
    expect(build?.input).not.toContain("FROM sha256:");
    expect(build?.input).toContain(
      "ARG BASE_IMAGE=prtisan.invalid/runtime-input:base-"
    );
    const temporaryTags = runner.calls.filter(
      (call) =>
        call.command === "docker" &&
        call.args[0] === "image" &&
        call.args[1] === "tag"
    );
    const temporaryRemovals = runner.calls.filter(
      (call) =>
        call.command === "docker" &&
        call.args[0] === "image" &&
        call.args[1] === "rm"
    );
    expect(temporaryTags).toHaveLength(3);
    expect(temporaryRemovals.map((call) => call.args[2]).sort()).toEqual(
      temporaryTags.map((call) => call.args[3]).sort()
    );
    expect(
      runner.calls.some(
        (call) =>
          call.command === "docker" &&
          call.args[0] === "pull" &&
          call.args[1] === "node:22.18.0-bookworm-slim"
      )
    ).toBe(true);
  });

  test("re-resolves runtime inputs once when an image disappears during preparation", async () => {
    const cwd = await temporaryDirectory();
    const baseImageId =
      "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const toolchainImageId =
      "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const toolsImageId =
      "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const runner = new RuntimeRunner([
      commandResult(0, `${baseImageId}\n`),
      commandResult(0),
      commandResult(0, `${toolchainImageId}\n`),
      commandResult(0),
      commandResult(0, `${toolsImageId}\n`),
      commandResult(1, "", "missing derivative"),
      commandResult(1, "", "Error response from daemon: No such image"),
      commandResult(0, `${baseImageId}\n`),
      commandResult(0),
      commandResult(0, `${toolchainImageId}\n`),
      commandResult(0),
      commandResult(0, `${toolsImageId}\n`),
      commandResult(1, "", "missing derivative"),
      commandResult(0),
      commandResult(0),
      commandResult(0),
      commandResult(0),
    ]);
    const config = testConfig({
      docker: {
        ...testConfig().docker,
        imagePolicy: "external",
      },
    });

    const image = await new DockerRuntimeImageBuilder(runner).ensureImage({
      cwd,
      config,
      profile: nodeToolchainProfile(),
    });

    expect(image).toMatch(/^prtisan\/runtime:[a-f0-9]{20}$/);
    expect(
      runner.calls.filter(
        (call) =>
          call.command === "docker" &&
          call.args[0] === "image" &&
          call.args[1] === "inspect" &&
          call.args[2] === config.docker.imageName
      )
    ).toHaveLength(2);
  });

  test("stops after one retry when a runtime input remains unavailable", async () => {
    const cwd = await temporaryDirectory();
    const baseImageId =
      "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const toolchainImageId =
      "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const toolsImageId =
      "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const firstAttempt = [
      commandResult(0, `${baseImageId}\n`),
      commandResult(0),
      commandResult(0, `${toolchainImageId}\n`),
      commandResult(0),
      commandResult(0, `${toolsImageId}\n`),
      commandResult(1, "", "missing derivative"),
      commandResult(1, "", "Error response from daemon: No such image"),
    ];
    const runner = new RuntimeRunner([...firstAttempt, ...firstAttempt]);
    const config = testConfig({
      docker: {
        ...testConfig().docker,
        imagePolicy: "external",
      },
    });

    await expect(
      new DockerRuntimeImageBuilder(runner).ensureImage({
        cwd,
        config,
        profile: nodeToolchainProfile(),
      })
    ).rejects.toThrow("Unable to create local base runtime image reference");
    expect(
      runner.calls.filter(
        (call) =>
          call.command === "docker" &&
          call.args[0] === "image" &&
          call.args[1] === "inspect" &&
          call.args[2] === config.docker.imageName
      )
    ).toHaveLength(2);
  });

  test("uses a new derivative tag when an upstream image ID changes", async () => {
    const cwd = await temporaryDirectory();
    const baseImageId =
      "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const firstToolchainImageId =
      "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const secondToolchainImageId =
      "sha256:4444444444444444444444444444444444444444444444444444444444444444";
    const toolsImageId =
      "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const config = testConfig({
      docker: {
        ...testConfig().docker,
        imagePolicy: "external",
      },
    });

    const first = await new DockerRuntimeImageBuilder(
      new RuntimeRunner(
        successfulRuntimeBuildResults(
          baseImageId,
          firstToolchainImageId,
          toolsImageId
        )
      )
    ).ensureImage({
      cwd,
      config,
      profile: nodeToolchainProfile(),
    });
    const second = await new DockerRuntimeImageBuilder(
      new RuntimeRunner(
        successfulRuntimeBuildResults(
          baseImageId,
          secondToolchainImageId,
          toolsImageId
        )
      )
    ).ensureImage({
      cwd,
      config,
      profile: nodeToolchainProfile(),
    });

    expect(second).not.toBe(first);
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

  test("classifies unavailable verification Git metadata as infrastructure", async () => {
    const cwd = await temporaryDirectory();
    const runner = new RuntimeRunner([
      commandResult(0),
      commandResult(128, "", "fatal: not a git repository"),
    ]);
    const result = await new DockerVerificationRunner(runner).verify({
      cwd,
      runId: "runtime-test",
      label: "missing-git-metadata",
      ref: "repair-sha",
      config: testConfig(),
      runtime: preparedRuntime(),
    });

    expect(result.status).toBe("infra_failed");
    expect(result.commands[1]).toMatchObject({
      name: "Project check",
      exitCode: 128,
      output: "fatal: not a git repository",
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
    const dockerCalls = runner.calls.filter(
      (call) => call.command === "docker" && call.args[0] === "run"
    );
    expect(dockerCalls.map((call) => call.timeoutMs)).toEqual([900, 300]);
    for (const call of dockerCalls) {
      expect(call.args).toContain(`${cwd}/.git:${cwd}/.git:ro`);
    }
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
    readonly input?: string;
    readonly timeoutMs?: number;
  }[] = [];

  constructor(
    private readonly dockerResults: CommandResult[],
    private readonly onCall?: (call: {
      readonly command: string;
      readonly args: readonly string[];
      readonly input?: string;
      readonly timeoutMs?: number;
    }) => void
  ) {}

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    const call = {
      command,
      args,
      input: options?.input,
      timeoutMs: options?.timeoutMs,
    };
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

function nodeToolchainProfile() {
  return {
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

function successfulRuntimeBuildResults(
  baseImageId: string,
  toolchainImageId: string,
  toolsImageId: string
): CommandResult[] {
  return [
    commandResult(0, `${baseImageId}\n`),
    commandResult(0),
    commandResult(0, `${toolchainImageId}\n`),
    commandResult(0),
    commandResult(0, `${toolsImageId}\n`),
    commandResult(1, "", "missing derivative"),
    commandResult(0),
    commandResult(0),
    commandResult(0),
    commandResult(0),
  ];
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "prtisan-runtime-test-"));
  temporaryDirectories.push(path);
  return path;
}
