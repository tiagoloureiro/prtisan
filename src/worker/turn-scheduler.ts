import {
  type ConversationService,
  type ConversationTurnResult,
} from "@/control/conversation-service.js";
import type { ControlStore } from "@/control/store.js";
import type { WorkerJob } from "@/control/types.js";

import type { ConversationLocks } from "./conversation-lock.js";

interface Waiter {
  readonly resolve: (result: ConversationTurnResult) => void;
  readonly reject: (error: unknown) => void;
}

export class ConversationTurnScheduler {
  private readonly pending: WorkerJob[] = [];
  private readonly pendingIds = new Set<string>();
  private readonly activeConversations = new Set<string>();
  private readonly waiters = new Map<string, Waiter>();
  private active = 0;

  constructor(
    private readonly store: ControlStore,
    private readonly conversations: ConversationService,
    private readonly locks: ConversationLocks,
    private readonly limit: number
  ) {}

  get busy(): boolean {
    return this.active > 0 || this.pending.length > 0;
  }

  restore(): void {
    for (const job of this.store.listJobs({
      kind: "conversation_turn",
      statuses: ["queued"],
    })) {
      this.add(job);
    }
    this.pump();
  }

  submit(input: Parameters<ConversationService["enqueueTurn"]>[0]) {
    const job = this.conversations.enqueueTurn(input);
    const completion = new Promise<ConversationTurnResult>(
      (resolve, reject) => {
        this.waiters.set(job.id, { resolve, reject });
      }
    );
    this.add(job);
    this.pump();
    return completion;
  }

  private add(job: WorkerJob): void {
    if (this.pendingIds.has(job.id)) return;
    this.pendingIds.add(job.id);
    this.pending.push(job);
  }

  private pump(): void {
    while (this.active < Math.max(1, this.limit)) {
      const index = this.pending.findIndex(
        (job) =>
          job.conversationId !== undefined &&
          !this.activeConversations.has(job.conversationId)
      );
      if (index < 0) return;
      const [job] = this.pending.splice(index, 1);
      if (!job?.conversationId) continue;
      this.pendingIds.delete(job.id);
      this.active += 1;
      this.activeConversations.add(job.conversationId);
      void this.locks
        .run(job.conversationId, () => this.conversations.runTurn(job.id))
        .then((result) => this.waiters.get(job.id)?.resolve(result))
        .catch((error) => this.waiters.get(job.id)?.reject(error))
        .finally(() => {
          this.waiters.delete(job.id);
          this.active -= 1;
          this.activeConversations.delete(job.conversationId as string);
          this.pump();
        });
    }
  }
}
