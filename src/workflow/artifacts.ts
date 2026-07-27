import { createHash } from "node:crypto";

import { ensureDir, readText, writeText } from "@/fs.js";
import { joinPath } from "@/path.js";
import { sanitizeForGitHub } from "@/redaction.js";

export interface ArtifactStore {
  put(
    contents: string
  ): Promise<{ readonly digest: string; readonly path: string }>;
  get(digest: string): Promise<string | undefined>;
}

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async put(
    contents: string
  ): Promise<{ readonly digest: string; readonly path: string }> {
    const safe = sanitizeForGitHub(contents);
    const digest = createHash("sha256").update(safe).digest("hex");
    const path = joinPath(this.root, digest.slice(0, 2), digest);
    await ensureDir(joinPath(this.root, digest.slice(0, 2)));
    await writeText(path, safe);
    return { digest, path };
  }

  async get(digest: string): Promise<string | undefined> {
    if (!/^[a-f0-9]{64}$/.test(digest)) return undefined;
    try {
      return await readText(joinPath(this.root, digest.slice(0, 2), digest));
    } catch {
      return undefined;
    }
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly values = new Map<string, string>();

  async put(
    contents: string
  ): Promise<{ readonly digest: string; readonly path: string }> {
    const safe = sanitizeForGitHub(contents);
    const digest = createHash("sha256").update(safe).digest("hex");
    this.values.set(digest, safe);
    return { digest, path: `memory:${digest}` };
  }

  async get(digest: string): Promise<string | undefined> {
    return this.values.get(digest);
  }
}
