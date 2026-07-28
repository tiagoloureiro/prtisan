import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { PrtisanCleanup } from "@/cleanup.js";
import { ControlStore } from "@/control/store.js";
import type { CommandResult, CommandRunner } from "@/exec.js";
import { prtisanRepositoryDataPath } from "@/prtisan-paths.js";

describe("cleanup command", () => {
  test("removes selected Project caches while preserving durable control state", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-cleanup-command-"));
    const store = await ControlStore.open(join(root, "control.sqlite"));
    try {
      const project = store.importProject({ cwd: root });
      const cache = prtisanRepositoryDataPath(root, "cache", "reviews");
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, "entry.json"), "{}");
      const cleanup = new PrtisanCleanup(store, new CleanupRunner());

      const preview = await cleanup.preview({
        projectId: project.id,
        categories: ["caches"],
      });
      expect(preview.candidates).toEqual([
        expect.objectContaining({
          category: "caches",
          action: "remove",
          target: prtisanRepositoryDataPath(root, "cache"),
        }),
      ]);

      const result = await cleanup.execute({
        authorizationId: preview.authorizationId,
        candidateIds: preview.candidates
          .filter((candidate) => candidate.action === "remove")
          .map((candidate) => candidate.id),
      });
      expect(result.removed).toHaveLength(1);
      expect(result.failed).toEqual([]);
      expect(store.project(project.id)).toBeDefined();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses Docker ownership labels and skips active containers", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-cleanup-docker-"));
    const store = await ControlStore.open(join(root, "control.sqlite"));
    try {
      const project = store.importProject({ cwd: root });
      const cleanup = new PrtisanCleanup(store, new CleanupRunner(project.id));
      const preview = await cleanup.preview({
        projectId: project.id,
        categories: ["containers", "images"],
      });

      expect(preview.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "container:running",
            action: "skip",
            reason: "container is active",
          }),
          expect.objectContaining({
            id: "container:stopped",
            action: "remove",
          }),
          expect.objectContaining({
            id: "image:owned-image",
            action: "remove",
          }),
        ])
      );
      expect(
        preview.candidates.some((candidate) =>
          candidate.target.includes("other-image")
        )
      ).toBe(false);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects forged candidates and consumes authorizations once", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-cleanup-auth-"));
    const store = await ControlStore.open(join(root, "control.sqlite"));
    try {
      const project = store.importProject({ cwd: root });
      const cache = prtisanRepositoryDataPath(root, "cache");
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, "entry.json"), "{}");
      const cleanup = new PrtisanCleanup(store, new CleanupRunner());
      const preview = await cleanup.preview({
        projectId: project.id,
        categories: ["caches"],
      });

      await expect(
        cleanup.execute({
          authorizationId: preview.authorizationId,
          candidateIds: ["logs:/unrelated"],
        })
      ).rejects.toThrow("not authorized");
      expect(await Bun.file(join(cache, "entry.json")).exists()).toBe(true);

      const retry = await cleanup.preview({
        projectId: project.id,
        categories: ["caches"],
      });
      const request = {
        authorizationId: retry.authorizationId,
        candidateIds: retry.candidates
          .filter((candidate) => candidate.action === "remove")
          .map((candidate) => candidate.id),
      };
      await cleanup.execute(request);
      await expect(cleanup.execute(request)).rejects.toThrow(
        "expired or is no longer valid"
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rechecks queued Turn activity before removing a Conversation worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-cleanup-turn-race-"));
    const store = await ControlStore.open(join(root, "control.sqlite"));
    const publishedSha = "a".repeat(40);
    let worktree = "";
    try {
      const project = store.importProject({ cwd: root });
      const conversation = store.createConversation({
        projectId: project.id,
        title: "Published work",
        baseRef: "main",
        baseSha: publishedSha,
        profile: { model: "test", reasoningEffort: "medium" },
      });
      store.updateConversation(conversation.id, {
        status: "published",
        pullRequestNumber: 7,
        pullRequestUrl: "https://github.com/o/r/pull/7",
        publishedSha,
      });
      worktree = prtisanRepositoryDataPath(
        root,
        "conversations",
        conversation.id,
        "worktree"
      );
      await mkdir(worktree, { recursive: true });
      const cleanup = new PrtisanCleanup(
        store,
        new WorktreeCleanupRunner(worktree, publishedSha)
      );
      const preview = await cleanup.preview({
        projectId: project.id,
        categories: ["worktrees"],
      });
      expect(preview.candidates[0]?.action).toBe("remove");

      store.createJob({
        projectId: project.id,
        conversationId: conversation.id,
        kind: "conversation_turn",
        input: { text: "More work", attachmentPaths: [] },
      });
      const result = await cleanup.execute({
        authorizationId: preview.authorizationId,
        candidateIds: [preview.candidates[0]?.id as string],
      });

      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("queued or running Turn");
      expect((await stat(worktree)).isDirectory()).toBe(true);
    } finally {
      store.close();
      if (worktree) await rm(worktree, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves archived Conversations whose commits were never published", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-cleanup-unpublished-"));
    const store = await ControlStore.open(join(root, "control.sqlite"));
    let worktree = "";
    try {
      const project = store.importProject({ cwd: root });
      const conversation = store.createConversation({
        projectId: project.id,
        title: "Local work",
        baseRef: "main",
        baseSha: "a".repeat(40),
        profile: { model: "test", reasoningEffort: "medium" },
      });
      store.updateConversation(conversation.id, { status: "archived" });
      worktree = prtisanRepositoryDataPath(
        root,
        "conversations",
        conversation.id,
        "worktree"
      );
      await mkdir(worktree, { recursive: true });
      const cleanup = new PrtisanCleanup(
        store,
        new WorktreeCleanupRunner(worktree, "b".repeat(40))
      );

      const preview = await cleanup.preview({
        projectId: project.id,
        categories: ["worktrees"],
      });

      expect(preview.candidates[0]).toEqual(
        expect.objectContaining({
          action: "skip",
          reason: "Conversation has unpublished work",
        })
      );
    } finally {
      store.close();
      if (worktree) await rm(worktree, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

class CleanupRunner implements CommandRunner {
  constructor(private readonly projectId = "") {}

  async run(
    command: string,
    args: readonly string[] = []
  ): Promise<CommandResult> {
    let stdout = "";
    if (command === "docker" && args[0] === "ps") {
      stdout = [
        `running\tUp 2 minutes\t${this.projectId}`,
        `stopped\tExited (0)\t${this.projectId}`,
        "other\tExited (0)\tproject-other",
      ].join("\n");
    } else if (
      command === "docker" &&
      args[0] === "image" &&
      args[1] === "ls"
    ) {
      stdout = [
        `owned-image\tprtisan/runtime:test\t${this.projectId}`,
        "other-image\tprtisan/runtime:other\tproject-other",
      ].join("\n");
    } else if (command === "du") {
      stdout = "1\tpath\n";
    }
    return {
      command: [command, ...args],
      stdout,
      stderr: "",
      exitCode: 0,
    };
  }
}

class WorktreeCleanupRunner implements CommandRunner {
  constructor(
    private readonly worktree: string,
    private readonly head: string
  ) {}

  async run(
    command: string,
    args: readonly string[] = []
  ): Promise<CommandResult> {
    let stdout = "";
    if (command === "git" && args[0] === "worktree" && args[1] === "list") {
      stdout = `worktree ${this.worktree}\nHEAD ${this.head}\nbranch refs/heads/test\n\n`;
    } else if (command === "git" && args[0] === "rev-parse") {
      stdout = `${this.head}\n`;
    } else if (command === "du") {
      stdout = "1\tpath\n";
    }
    return {
      command: [command, ...args],
      stdout,
      stderr: "",
      exitCode: 0,
    };
  }
}
