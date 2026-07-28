import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { ControlStore } from "@/control/store.js";

describe("control store", () => {
  test("keeps Projects, Conversations, messages, and archive state separate from the workflow journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-control-store-"));
    const store = await ControlStore.open(join(root, "control.sqlite"));
    try {
      const project = store.importProject({
        cwd: "/work/one",
        repository: "o/r",
        createdAt: "2026-07-28T00:00:00.000Z",
      });
      const duplicateClone = store.importProject({
        cwd: "/work/two",
        repository: "o/r",
        createdAt: "2026-07-28T00:00:01.000Z",
      });
      expect(project.id).not.toBe(duplicateClone.id);

      const conversation = store.createConversation({
        projectId: project.id,
        title: "Build the TUI",
        baseRef: "main",
        baseSha: "a".repeat(40),
        profile: {
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
        },
      });
      const message = store.addMessage({
        conversationId: conversation.id,
        role: "user",
        text: "Start with the control plane.",
      });

      expect(store.listConversations(project.id)).toHaveLength(1);
      expect(
        store.updateConversation(conversation.id, {
          publishedSha: "b".repeat(40),
        }).publishedSha
      ).toBe("b".repeat(40));
      expect(store.listMessages(conversation.id)).toEqual([message]);
      const [proposal] = store.addProposals(message.id, conversation.id, [
        {
          kind: "workflow_run",
          title: "Run the train",
          payload: {},
          preconditionDigest: "snapshot",
        },
      ]);
      expect(store.listProposals(conversation.id)).toEqual([proposal]);
      expect(
        store.updateProposal(proposal?.id as string, "rejected").status
      ).toBe("rejected");
      expect(store.archiveProject(project.id, true).archived).toBe(true);
      expect(store.listProjects({ archived: false })).toEqual([
        expect.objectContaining({ id: duplicateClone.id }),
      ]);
      expect(store.archiveProject(project.id, false).archived).toBe(false);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks active jobs interrupted during Worker recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "prtisan-control-jobs-"));
    const store = await ControlStore.open(join(root, "control.sqlite"));
    try {
      const job = store.createJob({
        kind: "conversation_turn",
        input: { prompt: "hello" },
      });
      store.updateJob(job.id, "running");
      const queued = store.createJob({
        conversationId: undefined,
        kind: "conversation_turn",
        input: { text: "queued", attachmentPaths: [] },
      });
      expect(store.interruptRunningJobs()).toBe(1);
      expect(store.interruptRunningJobs()).toBe(0);
      expect(
        store
          .listJobs({ kind: "conversation_turn", statuses: ["queued"] })
          .map((item) => item.id)
      ).toEqual([queued.id]);
      expect(store.claimQueuedJob(queued.id)?.status).toBe("running");
      expect(store.claimQueuedJob(queued.id)).toBeUndefined();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
