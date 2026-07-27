import { Database } from "bun:sqlite";

import type { CommandRunner } from "./exec.js";
import { ensureDir } from "./fs.js";
import type { defaultManifest } from "./manifest.js";
import { dirname } from "./path.js";
import { recommendedManifest } from "./scaffold.js";
import { stableDigest } from "./validation-hardening.js";

export interface SetupPlan {
  readonly schemaVersion: 1;
  readonly kind: "setup";
  readonly id: string;
  readonly cwd: string;
  readonly repo: string;
  readonly targetBranch: string;
  readonly targetHead: string;
  readonly branch: "prtisan/setup";
  readonly createdAt: string;
  readonly proposedManifest: ReturnType<typeof defaultManifest>;
}

export class SetupPlanStore {
  private constructor(private readonly database: Database) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS setup_plans (
        id TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  static async open(path: string): Promise<SetupPlanStore> {
    await ensureDir(dirname(path));
    return new SetupPlanStore(new Database(path, { create: true }));
  }

  save(plan: SetupPlan): void {
    this.database
      .query(
        "INSERT OR IGNORE INTO setup_plans (id, plan_json, created_at) VALUES (?, ?, ?)"
      )
      .run(plan.id, JSON.stringify(plan), plan.createdAt);
  }

  load(id: string): SetupPlan | undefined {
    const row = this.database
      .query<{ plan_json: string }, [string]>(
        "SELECT plan_json FROM setup_plans WHERE id = ?"
      )
      .get(id);
    return row ? (JSON.parse(row.plan_json) as SetupPlan) : undefined;
  }

  close(): void {
    this.database.close();
  }
}

export async function createSetupPlan(input: {
  readonly cwd: string;
  readonly runner: CommandRunner;
  readonly now?: Date;
}): Promise<SetupPlan> {
  const rootResult = await input.runner.run(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: input.cwd }
  );
  const cwd = rootResult.stdout.trim();
  if (rootResult.exitCode !== 0 || !cwd) {
    throw new Error("Prtisan setup requires a Git repository.");
  }
  const repoResult = await input.runner.run(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    { cwd }
  );
  if (repoResult.exitCode !== 0) {
    throw new Error(
      `Unable to inspect GitHub repository: ${repoResult.stderr}`
    );
  }
  const repository = JSON.parse(repoResult.stdout) as {
    nameWithOwner?: unknown;
    defaultBranchRef?: { name?: unknown };
  };
  if (
    typeof repository.nameWithOwner !== "string" ||
    typeof repository.defaultBranchRef?.name !== "string"
  ) {
    throw new Error("GitHub repository discovery returned incomplete data.");
  }
  const targetBranch = repository.defaultBranchRef.name;
  const fetch = await input.runner.run(
    "git",
    [
      "fetch",
      "origin",
      `refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
    ],
    { cwd }
  );
  if (fetch.exitCode !== 0) {
    throw new Error(`Unable to fetch origin/${targetBranch}: ${fetch.stderr}`);
  }
  const head = await input.runner.run(
    "git",
    ["rev-parse", `origin/${targetBranch}`],
    { cwd }
  );
  const createdAt = (input.now ?? new Date()).toISOString();
  const value = {
    schemaVersion: 1 as const,
    kind: "setup" as const,
    cwd,
    repo: repository.nameWithOwner,
    targetBranch,
    targetHead: head.stdout.trim(),
    branch: "prtisan/setup" as const,
    createdAt,
    proposedManifest: await recommendedManifest(cwd, targetBranch),
  };
  const digest = stableDigest(value);
  return { ...value, id: `setup-${digest.slice(0, 16)}` };
}

export async function assertSetupPlanFresh(
  plan: SetupPlan,
  runner: CommandRunner
): Promise<void> {
  const fetch = await runner.run(
    "git",
    [
      "fetch",
      "origin",
      `refs/heads/${plan.targetBranch}:refs/remotes/origin/${plan.targetBranch}`,
    ],
    { cwd: plan.cwd }
  );
  if (fetch.exitCode !== 0) {
    throw new Error(`Unable to refresh origin/${plan.targetBranch}.`);
  }
  const current = await runner.run(
    "git",
    ["rev-parse", `origin/${plan.targetBranch}`],
    { cwd: plan.cwd }
  );
  if (current.stdout.trim() !== plan.targetHead) {
    throw new Error(
      `Setup plan ${plan.id} is stale because ${plan.targetBranch} changed. Create a fresh setup plan.`
    );
  }
}
