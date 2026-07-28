import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type {
  ConversationService,
  ConversationTurnResult,
} from "@/control/conversation-service.js";
import { ControlStore } from "@/control/store.js";
import type { ConversationTurnJobInput } from "@/control/types.js";
import { ConversationLocks } from "@/worker/conversation-lock.js";
import { ConversationTurnScheduler } from "@/worker/turn-scheduler.js";

describe("Conversation Turn scheduler", () => {
  test("runs FIFO per Conversation while allowing another Conversation concurrently", async () => {
    const fixture = await schedulerFixture(2);
    try {
      const first = fixture.scheduler.submit({
        conversationId: fixture.firstConversationId,
        text: "first-a",
      });
      const second = fixture.scheduler.submit({
        conversationId: fixture.firstConversationId,
        text: "second-a",
      });
      const other = fixture.scheduler.submit({
        conversationId: fixture.secondConversationId,
        text: "first-b",
      });

      await waitFor(() => fixture.started.length === 2);
      expect(fixture.started).toEqual(["first-a", "first-b"]);

      fixture.finish("first-a");
      await waitFor(() => fixture.started.includes("second-a"));
      expect(fixture.started).toEqual(["first-a", "first-b", "second-a"]);

      fixture.finish("first-b");
      fixture.finish("second-a");
      await Promise.all([first, second, other]);
    } finally {
      await fixture.dispose();
    }
  });

  test("restores durable queued Turns after Worker restart", async () => {
    const fixture = await schedulerFixture(1, false);
    try {
      const job = fixture.store.createJob({
        projectId: fixture.projectId,
        conversationId: fixture.firstConversationId,
        kind: "conversation_turn",
        input: { text: "restored", attachmentPaths: [] },
      });

      fixture.scheduler.restore();
      await waitFor(() => fixture.started.includes("restored"));
      fixture.finish("restored");
      await waitFor(() => fixture.store.job(job.id)?.status === "completed");

      expect(fixture.store.job(job.id)?.status).toBe("completed");
    } finally {
      await fixture.dispose();
    }
  });
});

async function schedulerFixture(limit: number, autoCreate = true) {
  const root = await mkdtemp(join(tmpdir(), "prtisan-turn-scheduler-"));
  const store = await ControlStore.open(join(root, "control.sqlite"));
  const project = store.importProject({ cwd: root });
  const first = store.createConversation({
    projectId: project.id,
    title: "First",
    baseRef: "main",
    baseSha: "a".repeat(40),
    profile: { model: "test", reasoningEffort: "medium" },
  });
  const second = store.createConversation({
    projectId: project.id,
    title: "Second",
    baseRef: "main",
    baseSha: "a".repeat(40),
    profile: { model: "test", reasoningEffort: "medium" },
  });
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const service = {
    enqueueTurn(input: {
      conversationId: string;
      text: string;
      attachmentPaths?: readonly string[];
    }) {
      if (!autoCreate) throw new Error("Unexpected enqueue.");
      return store.createJob({
        projectId: project.id,
        conversationId: input.conversationId,
        kind: "conversation_turn",
        input: {
          text: input.text,
          attachmentPaths: input.attachmentPaths ?? [],
        } satisfies ConversationTurnJobInput,
      });
    },
    async runTurn(jobId: string): Promise<ConversationTurnResult> {
      const job = store.claimQueuedJob(jobId);
      if (!job) throw new Error("Job was not queued.");
      const input = job.input as ConversationTurnJobInput;
      started.push(input.text);
      await new Promise<void>((resolve) => gates.set(input.text, resolve));
      store.updateJob(job.id, "completed", { text: input.text });
      return { checkpointSha: input.text } as ConversationTurnResult;
    },
  } as unknown as ConversationService;
  const scheduler = new ConversationTurnScheduler(
    store,
    service,
    new ConversationLocks(),
    limit
  );
  return {
    store,
    scheduler,
    projectId: project.id,
    firstConversationId: first.id,
    secondConversationId: second.id,
    started,
    finish(text: string) {
      const release = gates.get(text);
      if (!release) throw new Error(`Turn ${text} has not started.`);
      gates.delete(text);
      release();
    },
    async dispose() {
      for (const release of gates.values()) release();
      await waitFor(() => !scheduler.busy);
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for scheduler state.");
}
