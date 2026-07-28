import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  buildConversationDockerArgs,
  conversationPrompt,
  ConversationService,
} from "@/control/conversation-service.js";
import { ControlStore } from "@/control/store.js";
import type { ConversationAttachment } from "@/control/types.js";
import type { CommandResult, CommandRunner } from "@/exec.js";
import { prtisanRepositoryDataPath } from "@/prtisan-paths.js";

describe("Conversation service", () => {
  test("mounts captured attachments read-only at prompt-visible container paths", () => {
    const attachment: ConversationAttachment = {
      kind: "image",
      name: "screen.png",
      path: "/host/prtisan/attachments/screen.png",
      digest: "a".repeat(64),
      mediaType: "image/png",
    };
    const args = buildConversationDockerArgs({
      projectId: "project-1",
      conversationId: "conversation-1",
      profile: { model: "test", reasoningEffort: "medium" },
      worktree: "/host/worktree",
      codexHome: "/host/codex",
      attachments: [attachment],
    });
    const mount =
      "/host/prtisan/attachments/screen.png:/home/agent/attachments/0-" +
      "a".repeat(64) +
      ":ro";
    const prompt = conversationPrompt("Inspect it", [attachment]);

    expect(args).toContain(mount);
    expect(prompt).toContain(`/home/agent/attachments/0-${"a".repeat(64)}`);
    expect(prompt).not.toContain(attachment.path);
  });

  test("publishes later checkpoints to the existing pull request without creating another", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-republish-"));
    const store = await ControlStore.open(join(root, "control.sqlite"));
    try {
      const project = store.importProject({ cwd: root });
      const conversation = store.createConversation({
        projectId: project.id,
        title: "Continue the PR",
        baseRef: "main",
        baseSha: "a".repeat(40),
        profile: { model: "test", reasoningEffort: "medium" },
      });
      store.updateConversation(conversation.id, {
        status: "published",
        pullRequestNumber: 17,
        pullRequestUrl: "https://github.com/o/r/pull/17",
        publishedSha: "b".repeat(40),
      });
      const worktree = prtisanRepositoryDataPath(
        root,
        "conversations",
        conversation.id,
        "worktree"
      );
      await mkdir(worktree, { recursive: true });
      const runner = new PublishingRunner("c".repeat(40));
      const service = new ConversationService(store, runner);

      const published = await service.publish({
        conversationId: conversation.id,
        baseBranch: "main",
      });

      expect(published.publishedSha).toBe("c".repeat(40));
      expect(published.pullRequestNumber).toBe(17);
      expect(runner.commands).toContainEqual([
        "git",
        "push",
        "--set-upstream",
        "origin",
        conversation.branch,
      ]);
      expect(runner.commands.some(([command]) => command === "gh")).toBe(false);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

class PublishingRunner implements CommandRunner {
  readonly commands: string[][] = [];

  constructor(private readonly head: string) {}

  async run(
    command: string,
    args: readonly string[] = []
  ): Promise<CommandResult> {
    this.commands.push([command, ...args]);
    return {
      command: [command, ...args],
      stdout:
        command === "git" && args[0] === "rev-parse" ? `${this.head}\n` : "",
      stderr: "",
      exitCode: 0,
    };
  }
}
