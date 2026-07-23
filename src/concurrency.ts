export async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  task: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (limit < 1) {
    throw new Error("Concurrency limit must be at least 1.");
  }

  const results = new Array<R>(values.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(values[index] as T, index);
    }
  }

  const workerCount = Math.min(limit, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function createLimiter(
  limit: number
): <T>(task: () => Promise<T>) => Promise<T> {
  if (limit < 1) {
    throw new Error("Concurrency limit must be at least 1.");
  }

  let active = 0;
  const queue: (() => void)[] = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      queue.push(resolve);
    });
    active += 1;
  }

  function release(): void {
    active -= 1;
    queue.shift()?.();
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
