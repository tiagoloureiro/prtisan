import { open } from "node:fs/promises";

import { ensureDir } from "./fs.js";
import { joinPath } from "./path.js";
import { stableDigest } from "./validation-hardening.js";

export interface RepairAttemptStore {
  claim(key: string): Promise<boolean>;
}

export class FileRepairAttemptStore implements RepairAttemptStore {
  constructor(private readonly cwd: string) {}

  async claim(key: string): Promise<boolean> {
    const directory = joinPath(
      this.cwd,
      ".sandcastle",
      "cache",
      "repair-attempts"
    );
    await ensureDir(directory);
    const path = joinPath(directory, `${stableDigest(key)}.json`);

    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            schemaVersion: 1,
            claimedAt: new Date().toISOString(),
          })}\n`
        );
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
}

export class InMemoryRepairAttemptStore implements RepairAttemptStore {
  private readonly claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}
