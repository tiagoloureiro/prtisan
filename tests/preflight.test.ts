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
      expect.objectContaining({ name: "Dedicated CODEX_HOME", status: "ok" })
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
