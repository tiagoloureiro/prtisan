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
