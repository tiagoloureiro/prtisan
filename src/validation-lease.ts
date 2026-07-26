import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { ensureDir } from "./fs.js";
import { joinPath } from "./path.js";
import { stableDigest } from "./validation-hardening.js";

interface LeaseOwner {
  readonly pid: number;
  readonly createdAt: string;
  readonly snapshotKey: string;
  readonly token: string;
}

export interface ValidationLease {
  release(): Promise<void>;
}

export class ValidationLeaseManager {
  constructor(
    private readonly cwd: string,
    private readonly ttlMs: number
  ) {}

  async acquire(
    key: string,
    options: { readonly waitMs: number }
  ): Promise<ValidationLease> {
    const startedAt = Date.now();
    const lockPath = joinPath(
      this.cwd,
      ".sandcastle",
      "locks",
      stableDigest(key)
    );
    await ensureDir(joinPath(this.cwd, ".sandcastle", "locks"));

    while (true) {
      const token = crypto.randomUUID();
      const candidatePath = `${lockPath}.candidate-${process.pid}-${token}`;
      try {
        await mkdir(candidatePath);
        const owner = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          snapshotKey: key,
          token,
        } satisfies LeaseOwner;
        await writeFile(
          joinPath(candidatePath, "owner.json"),
          `${JSON.stringify(owner, null, 2)}\n`,
          { mode: 0o600 }
        );
        await rename(candidatePath, lockPath);
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            const current = await readOwner(lockPath);
            if (current?.token !== token) return;
            const releasePath = `${lockPath}.released-${token}`;
            try {
              await rename(lockPath, releasePath);
              await rm(releasePath, { recursive: true, force: true });
            } catch {
              // A stale lease may already have been reclaimed.
            }
          },
        };
      } catch (error) {
        await rm(candidatePath, { recursive: true, force: true });
        if (!isLeaseCollision(error)) throw error;
      }

      if (await this.reclaimIfStale(lockPath)) continue;
      if (Date.now() - startedAt >= options.waitMs) {
        throw new Error(
          `Timed out waiting for validation lease ${stableDigest(key).slice(0, 12)}.`
        );
      }
      await Bun.sleep(250);
    }
  }

  private async reclaimIfStale(lockPath: string): Promise<boolean> {
    const owner = await readOwner(lockPath);
    const createdAt = owner ? new Date(owner.createdAt).getTime() : 0;
    const expired =
      !Number.isFinite(createdAt) || Date.now() - createdAt > this.ttlMs;
    const dead = owner ? !processIsAlive(owner.pid) : true;
    if (!expired && !dead) return false;

    const stalePath = `${lockPath}.stale-${crypto.randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

const activeRuns = new Map<string, Promise<unknown>>();

export async function singleFlight<T>(
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const active = activeRuns.get(key);
  if (active) return active as Promise<T>;

  const promise = task().finally(() => {
    if (activeRuns.get(key) === promise) activeRuns.delete(key);
  });
  activeRuns.set(key, promise);
  return promise;
}

async function readOwner(lockPath: string): Promise<LeaseOwner | undefined> {
  try {
    return JSON.parse(
      await readFile(joinPath(lockPath, "owner.json"), "utf8")
    ) as LeaseOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLeaseCollision(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}
