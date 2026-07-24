import { describe, expect, test } from "bun:test";

import { assertRuntimeReady, checkRuntimeReadiness } from "@/preflight.js";

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
      "Error response from daemon: No such image: sandcastle:agent-train"
    );
    runner.enqueue("");
    runner.enqueue("Successfully built image\n");
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
      "Docker image sandcastle:agent-train is missing; building from .sandcastle/Dockerfile",
    ]);
    expect(runner.calls).toContainEqual({
      command: "docker",
      args: [
        "build",
        "-t",
        "sandcastle:agent-train",
        "--build-arg",
        `AGENT_UID=${process.getuid?.() ?? 1000}`,
        "--build-arg",
        `AGENT_GID=${process.getgid?.() ?? 1000}`,
        "-f",
        ".sandcastle/Dockerfile",
        ".",
      ],
      options: { cwd: "/repo" },
    });
  });

  test("reports the Docker build failure after a missing image build attempt", async () => {
    const runner = new FakeRunner();
    runner.enqueue("git version 2.50.0\n");
    runner.enqueue("Docker version 27.0.0\n");
    runner.enqueue("codex 1.0.0\n");
    runner.enqueue(
      "",
      1,
      "Error response from daemon: No such image: sandcastle:agent-train"
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
    expect((error as Error).message).toContain("Docker image build: groupadd");
    expect((error as Error).message).toContain(
      "Refresh the target repository scaffold"
    );
    expect((error as Error).message).not.toContain(
      "Docker image: Error response from daemon"
    );
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
