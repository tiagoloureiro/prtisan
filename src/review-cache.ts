import { rename, unlink } from "node:fs/promises";

import { ensureDir, pathExists, readJson, writeJson } from "./fs.js";
import { joinPath } from "./path.js";
import { prtisanRepositoryDataPath } from "./prtisan-paths.js";
import type {
  AgentRole,
  ModelProfile,
  ReviewAxis,
  ReviewReport,
} from "./types.js";
import { stableDigest } from "./validation-hardening.js";

interface ReviewCacheRecord {
  readonly createdAt: string;
  readonly report: ReviewReport;
}

export interface ReviewCache {
  get(key: string): Promise<ReviewReport | undefined>;
  set(key: string, report: ReviewReport): Promise<void>;
}

export class FileReviewCache implements ReviewCache {
  constructor(
    private readonly cwd: string,
    private readonly ttlDays: number,
    private readonly storageRoot?: string
  ) {}

  async get(key: string): Promise<ReviewReport | undefined> {
    const path = this.path(key);
    if (!(await pathExists(path))) return undefined;

    try {
      const record = await readJson<ReviewCacheRecord>(path);
      const ageMs = Date.now() - new Date(record.createdAt).getTime();
      if (
        !Number.isFinite(ageMs) ||
        ageMs > this.ttlDays * 24 * 60 * 60 * 1000
      ) {
        await unlink(path).catch(() => undefined);
        return undefined;
      }
      return record.report;
    } catch {
      await unlink(path).catch(() => undefined);
      return undefined;
    }
  }

  async set(key: string, report: ReviewReport): Promise<void> {
    const path = this.path(key);
    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await ensureDir(this.directory());
    await writeJson(temporaryPath, {
      createdAt: new Date().toISOString(),
      report,
    } satisfies ReviewCacheRecord);
    await rename(temporaryPath, path);
  }

  private path(key: string): string {
    return joinPath(this.directory(), `${stableDigest(key)}.json`);
  }

  private directory(): string {
    return (
      this.storageRoot ??
      prtisanRepositoryDataPath(this.cwd, "cache", "reviews")
    );
  }
}

export function reviewCacheKey(input: {
  readonly snapshotKey: string;
  readonly axis: ReviewAxis;
  readonly role: AgentRole;
  readonly profile: ModelProfile;
  readonly promptSchemaDigest: string;
}): string {
  return stableDigest(input);
}

export class InMemoryReviewCache implements ReviewCache {
  private readonly records = new Map<string, ReviewReport>();

  async get(key: string): Promise<ReviewReport | undefined> {
    return this.records.get(key);
  }

  async set(key: string, report: ReviewReport): Promise<void> {
    this.records.set(key, report);
  }
}
