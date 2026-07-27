import { open, readFile, stat, unlink } from "node:fs/promises";

import { ensureDir } from "./fs.js";
import { joinPath } from "./path.js";
import { prtisanRepositoryStatePath } from "./prtisan-paths.js";
import { stableDigest } from "./validation-hardening.js";

export interface RepairAttemptStore {
  claim(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export class FileRepairAttemptStore implements RepairAttemptStore {
  constructor(
    private readonly cwd: string,
    private readonly leaseTtlMs = 2 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
    private readonly storageRoot?: string
  ) {}

  async claim(key: string): Promise<boolean> {
    const directory = this.directory();
    await ensureDir(directory);
    const path = this.path(directory, key);

    return this.createClaim(path, key, true);
  }

  private async createClaim(
    path: string,
    key: string,
    reclaimExpired: boolean
  ): Promise<boolean> {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            schemaVersion: 2,
            state: "in_progress",
            key,
            claimedAt: new Date(this.now()).toISOString(),
          })}\n`
        );
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (reclaimExpired && (await this.isExpired(path))) {
          await unlink(path).catch(() => undefined);
          return this.createClaim(path, key, false);
        }
        return false;
      }
      throw error;
    }
  }

  private async isExpired(path: string): Promise<boolean> {
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as {
        claimedAt?: unknown;
      };
      if (typeof record.claimedAt !== "string") return true;
      const claimedAt = new Date(record.claimedAt).getTime();
      return (
        !Number.isFinite(claimedAt) || this.now() - claimedAt > this.leaseTtlMs
      );
    } catch {
      try {
        const file = await stat(path);
        return this.now() - file.mtimeMs > this.leaseTtlMs;
      } catch {
        return true;
      }
    }
  }

  async release(key: string): Promise<void> {
    const path = this.path(this.directory(), key);
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private directory(): string {
    return (
      this.storageRoot ??
      prtisanRepositoryStatePath(this.cwd, "repair-attempts")
    );
  }

  private path(directory: string, key: string): string {
    return joinPath(directory, `${stableDigest(key)}.json`);
  }
}

export class InMemoryRepairAttemptStore implements RepairAttemptStore {
  private readonly claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.claimed.delete(key);
  }
}
