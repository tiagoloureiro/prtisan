import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

import type { CommandOptions, CommandResult, CommandRunner } from "@/exec.js";
import { assertRuntimeReady, checkRuntimeReadiness } from "@/preflight.js";
import { prtisanPaths } from "@/prtisan-paths.js";

import { FakeRunner, testConfig } from "./helpers.js";

describe("runtime readiness", () => {
  test("returns structured diagnostics for local tools and auth", async () => {
    const runner = new FakeRunner();
    runner.enqueue("git version 2.50.0\n");
    runner.enqueue("Docker version 27.0.0\n");
    runner.enqueue("codex 1.0.0\n");
    runner.enqueue("[]\n");
    runner.enqueue("container-id\n");
    runner.enqueue("true\n");
    runner.enqueue("");
    runner.enqueue("container-id\n");
    runner.enqueue("");

    const diagnostics = await checkRuntimeReadiness({
      cwd: "/repo",
      config: testConfig(),
      runner,
      github: { assertReady: async () => {} },
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ name: "GitHub CLI", status: "ok" })
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ name: "Docker image", status: "ok" })
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        name: "Docker image default command",
        status: "ok",
      })
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ name: "Dedicated CODEX_HOME", status: "ok" })
    );
    expect(runner.calls).toContainEqual(
      expect.objectContaining({
        command: "test",
        args: [
          "-d",
          prtisanPaths().codexHome,
          "-a",
          "-s",
          `${prtisanPaths().codexHome}/auth.json`,
        ],
      })
    );
  });

  test("fails when the Docker image exits before Sandcastle can exec into it", async () => {
    const runner = new FakeRunner();
    runner.enqueue("git version 2.50.0\n");
    runner.enqueue("Docker version 27.0.0\n");
    runner.enqueue("codex 1.0.0\n");
    runner.enqueue("[]\n");
    runner.enqueue("container-id\n");
    runner.enqueue("false\n");
    runner.enqueue("container-id\n");
    runner.enqueue("");

    const diagnostics = await checkRuntimeReadiness({
      cwd: "/repo",
      config: testConfig(),
      runner,
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        name: "Docker image default command",
        status: "failed",
        details: expect.stringContaining('CMD ["sleep", "infinity"]'),
      })
    );
  });

  test("builds a missing Docker image before asserting runtime readiness", async () => {
    const runner = new FakeRunner();
    const logs: string[] = [];
    runner.enqueue("git version 2.50.0\n");
    runner.enqueue("Docker version 27.0.0\n");
    runner.enqueue("codex 1.0.0\n");
    runner.enqueue(
      "",
      1,
      "Error response from daemon: No such image: prtisan:repository"
    );
    runner.enqueue("");
    runner.enqueue(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
    );
    runner.enqueue(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
    );
    runner.enqueue("");
    runner.enqueue("git version 2.50.0\n");
    runner.enqueue("Docker version 27.0.0\n");
    runner.enqueue("codex 1.0.0\n");
    runner.enqueue("[]\n");
    runner.enqueue("container-id\n");
    runner.enqueue("true\n");
    runner.enqueue("");
    runner.enqueue("container-id\n");
    runner.enqueue("");

    await assertRuntimeReady({
      cwd: "/repo",
      config: testConfig(),
      runner,
      log: (message) => logs.push(message),
    });

    expect(logs).toEqual([
      "Building managed Docker image prtisan:repository from .prtisan/Dockerfile",
    ]);
    const build = runner.calls.find(
      (call) => call.command === "docker" && call.args[0] === "build"
    );
    expect(build?.args).toContain("--iidfile");
    expect(build?.args).toContain(`AGENT_UID=${process.getuid?.() ?? 1000}`);
    expect(build?.args).toContain(`AGENT_GID=${process.getgid?.() ?? 1000}`);
  });

  test("rebuilds a managed Docker image even when its configured tag exists", async () => {
    const runner = new ManagedPreflightRunner();

    await assertRuntimeReady({
      cwd: "/repo",
      config: testConfig(),
      runner,
    });

    expect(
      runner.calls.filter(
        (call) => call.command === "docker" && call.args[0] === "build"
      )
    ).toHaveLength(1);
  });

  test("reports the Docker build failure after a missing image build attempt", async () => {
    const runner = new FakeRunner();
    runner.enqueue("git version 2.50.0\n");
    runner.enqueue("Docker version 27.0.0\n");
    runner.enqueue("codex 1.0.0\n");
    runner.enqueue(
      "",
      1,
      "Error response from daemon: No such image: prtisan:repository"
    );
    runner.enqueue("");
    runner.enqueue("", 1, "groupadd: GID '1000' already exists");

    let error: unknown;
    try {
      await assertRuntimeReady({
        cwd: "/repo",
        config: testConfig(),
        runner,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Docker image build: Unable to build managed Docker image"
    );
    expect((error as Error).message).toContain(
      "groupadd: GID '1000' already exists"
    );
    expect((error as Error).message).toContain(
      "Refresh the target repository scaffold"
    );
    expect((error as Error).message).not.toContain(
      "Docker image: Error response from daemon"
    );
  });

  test("does not replace a missing externally managed Docker image", async () => {
    const runner = new FakeRunner();
    runner.enqueue("git version 2.50.0\n");
    runner.enqueue("Docker version 27.0.0\n");
    runner.enqueue("codex 1.0.0\n");
    runner.enqueue("", 1, "Error response from daemon: No such image");
    runner.enqueue("");
    runner.enqueue("", 1, "Error response from daemon: No such image");
    const config = testConfig({
      docker: {
        ...testConfig().docker,
        imageName: "registry.example.test/team/runtime:stable",
        imagePolicy: "external",
      },
    });

    await expect(
      assertRuntimeReady({
        cwd: "/repo",
        config,
        runner,
      })
    ).rejects.toThrow(
      "will not be built because docker.imagePolicy is external"
    );
    expect(
      runner.calls.some(
        (call) => call.command === "docker" && call.args[0] === "build"
      )
    ).toBe(false);
  });

  test("fails when the Docker image cannot write global Git config", async () => {
    const runner = new FakeRunner();
    runner.enqueue("git version 2.50.0\n");
    runner.enqueue("Docker version 27.0.0\n");
    runner.enqueue("codex 1.0.0\n");
    runner.enqueue("[]\n");
    runner.enqueue("container-id\n");
    runner.enqueue("true\n");
    runner.enqueue(
      "",
      255,
      "could not lock config file /home/agent/.gitconfig"
    );
    runner.enqueue("container-id\n");
    runner.enqueue("");

    const diagnostics = await checkRuntimeReadiness({
      cwd: "/repo",
      config: testConfig(),
      runner,
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        name: "Docker image default command",
        status: "failed",
        details: expect.stringContaining("/home/agent/.gitconfig"),
      })
    );
  });

  test("throws one readiness error with all failed diagnostics", async () => {
    const runner = new FakeRunner();
    runner.enqueue("git version 2.50.0\n");
    runner.enqueue("Docker version 27.0.0\n");
    runner.enqueue("", 1, "codex missing");
    runner.enqueue("", 1, "image missing");
    runner.enqueue("", 1, "codex home missing");

    await expect(
      assertRuntimeReady({
        cwd: "/repo",
        config: testConfig(),
        runner,
        github: {
          assertReady: async () => {
            throw new Error("gh auth missing");
          },
        },
      })
    ).rejects.toThrow("Runtime readiness failed");
  });
});

class ManagedPreflightRunner implements CommandRunner {
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
    let stdout = "";
    if (command === "git" && args[0] === "--version") {
      stdout = "git version 2.50.0\n";
    } else if (command === "docker" && args[0] === "--version") {
      stdout = "Docker version 29.0.0\n";
    } else if (command === "codex" && args[0] === "--version") {
      stdout = "codex 1.0.0\n";
    } else if (command === "docker" && args[0] === "image") {
      stdout =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
    } else if (command === "docker" && args[0] === "build") {
      const iidFile = args[args.indexOf("--iidfile") + 1];
      if (iidFile) {
        await writeFile(
          iidFile,
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
        );
      }
    } else if (command === "docker" && args[0] === "run") {
      stdout = "container-id\n";
    } else if (command === "docker" && args[0] === "inspect") {
      stdout = "true\n";
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
