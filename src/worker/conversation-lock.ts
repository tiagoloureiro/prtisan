export class ConversationLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(
    conversationId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(conversationId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(conversationId) === current) {
        this.tails.delete(conversationId);
      }
    }
  }
}
