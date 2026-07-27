import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { DockerBaseImageManager } from "@/docker-image.js";
import {
  BunCommandRunner,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  mustRun,
} from "@/exec.js";
import {
  DeclaredRuntimeProvider,
  DockerVerificationRunner,
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

test.skipIf(Bun.env.PRTISAN_DOCKER_INTEGRATION !== "1")(
  "builds the frozen declared runtime and verifies only inside Docker",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "prtisan-docker-test-"));
    temporaryDirectories.push(cwd);
    await mkdir(join(cwd, ".prtisan"), { recursive: true });
    await writeFile(
      join(cwd, ".prtisan", "Dockerfile"),
      [
        "FROM debian:bookworm-slim",
        "RUN apt-get update \\",
        "  && apt-get install -y --no-install-recommends git \\",
        "  && rm -rf /var/lib/apt/lists/*",
        "ARG AGENT_UID=1000",
        "ARG AGENT_GID=1000",
        "USER ${AGENT_UID}:${AGENT_GID}",
        'CMD ["sleep", "infinity"]',
        "",
      ].join("\n")
    );
    await writeFile(join(cwd, "README.md"), "frozen runtime fixture\n");
    const delegate = new BunCommandRunner();
    await mustRun(delegate, "git", ["init", "--initial-branch=main"], { cwd });
    await mustRun(delegate, "git", ["config", "user.name", "Test User"], {
      cwd,
    });
    await mustRun(
      delegate,
      "git",
      ["config", "user.email", "test@example.com"],
      { cwd }
    );
    await mustRun(
      delegate,
      "git",
      ["add", ".prtisan/Dockerfile", "README.md"],
      {
        cwd,
      }
    );
    await mustRun(delegate, "git", ["commit", "-m", "fixture"], { cwd });
    const frozen = (
      await mustRun(delegate, "git", ["rev-parse", "HEAD"], { cwd })
    ).stdout.trim();

    const id = randomUUID().replaceAll("-", "");
    const imageName = `prtisan.invalid/integration:${id}`;
    const config = testConfig({
      docker: {
        ...testConfig().docker,
        imageName,
        imagePolicy: "managed",
        dockerfile: ".prtisan/Dockerfile",
        context: ".",
      },
      runtime: {
        autoProvision: false,
        verificationMode: "explicit",
        probes: [],
        verification: [
          {
            name: "Frozen repository",
            command:
              "git rev-parse --is-inside-work-tree && git ls-files --error-unmatch README.md >/dev/null",
            timeoutMs: 30_000,
          },
        ],
      },
    });
    const runner = new RecordingRunner(delegate);

    try {
      const runtime = await new DeclaredRuntimeProvider(
        new DockerBaseImageManager(runner)
      ).prepare({ cwd, ref: frozen, config });
      expect(runtime.imageName).toMatch(/^sha256:[a-f0-9]{64}$/);

      const result = await new DockerVerificationRunner(runner).verify({
        cwd,
        runId: `integration-${id}`,
        label: "declared",
        ref: frozen,
        config,
        runtime,
      });

      expect(result.status).toBe("passed");
      expect(
        runner.results.some(
          (entry) =>
            entry.command[0] === "git" &&
            entry.command[1] === "worktree" &&
            entry.command.includes(frozen)
        )
      ).toBe(true);
      expect(
        runner.results.some(
          (entry) =>
            entry.command[0] === "docker" &&
            entry.command
              .join(" ")
              .includes("git rev-parse --is-inside-work-tree")
        )
      ).toBe(true);
      expect(
        runner.results.some(
          (entry) =>
            entry.command[0] !== "docker" &&
            entry.command
              .join(" ")
              .includes("git rev-parse --is-inside-work-tree")
        )
      ).toBe(false);
    } finally {
      await runner.run("docker", ["image", "rm", imageName], { cwd });
    }
  },
  20 * 60 * 1000
);

class RecordingRunner implements CommandRunner {
  readonly results: CommandResult[] = [];

  constructor(private readonly delegate: CommandRunner) {}

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions
  ): Promise<CommandResult> {
    const result = await this.delegate.run(command, args, options);
    this.results.push(result);
    return result;
  }
}
