import { randomUUID } from "node:crypto";
import { lstat, readdir, rm, stat } from "node:fs/promises";

import type { CommandRunner } from "@/exec.js";
import { joinPath, resolvePath } from "@/path.js";
import { prtisanPaths, prtisanRepositoryDataPath } from "@/prtisan-paths.js";

import type { ControlStore } from "./control/store.js";
import type { Project } from "./control/types.js";

export const CLEANUP_CATEGORIES = [
  "containers",
  "images",
  "worktrees",
  "caches",
  "logs",
  "sessions",
] as const;

export type CleanupCategory = (typeof CLEANUP_CATEGORIES)[number];

export interface CleanupCandidate {
  readonly id: string;
  readonly category: CleanupCategory;
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly description: string;
  readonly target: string;
  readonly ownershipEvidence: string;
  readonly estimatedBytes?: number;
  readonly action: "remove" | "skip";
  readonly reason?: string;
}

export interface CleanupPreview {
  readonly authorizationId: string;
  readonly scope:
    | { readonly kind: "all" }
    | { readonly kind: "project"; readonly projectId: string };
  readonly categories: readonly CleanupCategory[];
  readonly candidates: readonly CleanupCandidate[];
  readonly createdAt: string;
}

export interface CleanupExecutionRequest {
  readonly authorizationId: string;
  readonly candidateIds: readonly string[];
}

export interface CleanupResult {
  readonly preview: CleanupPreview;
  readonly removed: readonly CleanupCandidate[];
  readonly skipped: readonly CleanupCandidate[];
  readonly failed: readonly {
    readonly candidate: CleanupCandidate;
    readonly error: string;
  }[];
}

export class PrtisanCleanup {
  private readonly authorizations = new Map<
    string,
    {
      readonly preview: CleanupPreview;
      readonly removableIds: ReadonlySet<string>;
      readonly expiresAt: number;
    }
  >();

  constructor(
    private readonly store: ControlStore,
    private readonly runner: CommandRunner,
    private readonly withConversationLock: <T>(
      conversationId: string,
      operation: () => Promise<T>
    ) => Promise<T> = async (_conversationId, operation) => operation()
  ) {}

  async preview(input: {
    readonly projectId?: string;
    readonly all?: boolean;
    readonly categories?: readonly CleanupCategory[];
  }): Promise<CleanupPreview> {
    this.pruneAuthorizations();
    const inventory = await this.discover(input);
    const authorizationId = randomUUID();
    const preview: CleanupPreview = { authorizationId, ...inventory };
    this.authorizations.set(authorizationId, {
      preview,
      removableIds: new Set(
        preview.candidates
          .filter((candidate) => candidate.action === "remove")
          .map((candidate) => candidate.id)
      ),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return preview;
  }

  private async discover(input: {
    readonly projectId?: string;
    readonly all?: boolean;
    readonly categories?: readonly CleanupCategory[];
  }): Promise<Omit<CleanupPreview, "authorizationId">> {
    if (input.all === Boolean(input.projectId)) {
      throw new Error("Cleanup requires exactly one of a Project or --all.");
    }
    const categories = input.categories?.length
      ? [...new Set(input.categories)]
      : [...CLEANUP_CATEGORIES];
    const projects = input.all
      ? this.store.listProjects()
      : [this.requireProject(input.projectId as string)];
    const candidates: CleanupCandidate[] = [];

    if (categories.includes("containers")) {
      candidates.push(...(await this.dockerContainers(projects, input.all)));
    }
    if (categories.includes("images")) {
      candidates.push(...(await this.dockerImages(projects, input.all)));
    }
    for (const project of projects) {
      if (categories.includes("worktrees")) {
        candidates.push(...(await this.worktrees(project)));
      }
      if (categories.includes("caches")) {
        candidates.push(...(await this.directories(project, "caches")));
      }
      if (categories.includes("logs")) {
        candidates.push(...(await this.directories(project, "logs")));
      }
    }
    if (categories.includes("sessions")) {
      candidates.push(...(await this.sessions(projects, Boolean(input.all))));
    }
    return {
      scope: input.all
        ? { kind: "all" }
        : { kind: "project", projectId: input.projectId as string },
      categories,
      candidates,
      createdAt: new Date().toISOString(),
    };
  }

  async execute(request: CleanupExecutionRequest): Promise<CleanupResult> {
    const authorization = this.authorizations.get(request.authorizationId);
    this.authorizations.delete(request.authorizationId);
    if (!authorization || authorization.expiresAt < Date.now()) {
      throw new Error(
        "Cleanup authorization expired or is no longer valid; preview again."
      );
    }
    const requestedIds = [...new Set(request.candidateIds)];
    if (requestedIds.some((id) => !authorization.removableIds.has(id))) {
      throw new Error(
        "Cleanup execution included a candidate that was not authorized by the preview."
      );
    }
    const preview = authorization.preview;
    const fresh = await this.discover({
      ...(preview.scope.kind === "project"
        ? { projectId: preview.scope.projectId }
        : { all: true }),
      categories: preview.categories,
    });
    const freshCandidates = new Map(
      fresh.candidates.map((candidate) => [candidate.id, candidate])
    );
    const originalCandidates = new Map(
      preview.candidates.map((candidate) => [candidate.id, candidate])
    );
    const removed: CleanupCandidate[] = [];
    const skipped: CleanupCandidate[] = [];
    const failed: { candidate: CleanupCandidate; error: string }[] = [];
    for (const id of requestedIds) {
      const original = originalCandidates.get(id);
      if (!original) continue;
      const freshCandidate = freshCandidates.get(id);
      if (!freshCandidate) {
        skipped.push({
          ...original,
          action: "skip",
          reason: "target disappeared or is no longer eligible",
        });
        continue;
      }
      const operation = async () => {
        const candidate = await this.revalidate(freshCandidate);
        if (candidate.action === "skip") {
          skipped.push(candidate);
          return;
        }
        try {
          await this.removeCandidate(candidate);
          removed.push(candidate);
        } catch (error) {
          failed.push({
            candidate,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      if (
        freshCandidate.category === "worktrees" &&
        freshCandidate.conversationId
      ) {
        await this.withConversationLock(
          freshCandidate.conversationId,
          operation
        );
      } else {
        await operation();
      }
    }
    for (const candidate of preview.candidates) {
      if (candidate.action === "skip") skipped.push(candidate);
    }
    return { preview, removed, skipped, failed };
  }

  private pruneAuthorizations(): void {
    const now = Date.now();
    for (const [id, authorization] of this.authorizations) {
      if (authorization.expiresAt < now) this.authorizations.delete(id);
    }
  }

  private async dockerContainers(
    projects: readonly Project[],
    global: boolean | undefined
  ): Promise<CleanupCandidate[]> {
    const listed = await this.runner.run("docker", [
      "ps",
      "-a",
      "--filter",
      "label=io.prtisan.managed=true",
      "--format",
      '{{.ID}}\t{{.Status}}\t{{.Label "io.prtisan.project"}}',
    ]);
    if (listed.exitCode !== 0) return [];
    const selected = new Set(projects.map((project) => project.id));
    return listed.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        const [id, status = "", projectId = ""] = line.split("\t");
        if (!id || (!global && !selected.has(projectId))) return [];
        const running = /^Up\b|^Restarting\b|^Created\b/.test(status);
        return [
          {
            id: `container:${id}`,
            category: "containers" as const,
            ...(projectId ? { projectId } : {}),
            description: `Prtisan container ${id} (${status})`,
            target: id,
            ownershipEvidence: "Docker label io.prtisan.managed=true",
            action: running ? ("skip" as const) : ("remove" as const),
            ...(running ? { reason: "container is active" } : {}),
          },
        ];
      });
  }

  private async dockerImages(
    projects: readonly Project[],
    global: boolean | undefined
  ): Promise<CleanupCandidate[]> {
    const listed = await this.runner.run("docker", [
      "image",
      "ls",
      "--filter",
      "label=io.prtisan.managed=true",
      "--format",
      '{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Label "io.prtisan.project"}}',
    ]);
    if (listed.exitCode !== 0) return [];
    const selected = new Set(projects.map((project) => project.id));
    return listed.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        const [id, reference = "", projectId = ""] = line.split("\t");
        if (!id || (!global && !selected.has(projectId))) {
          return [];
        }
        return [
          {
            id: `image:${id}`,
            category: "images" as const,
            ...(projectId ? { projectId } : {}),
            description: `Prtisan image ${reference || id}`,
            target: id,
            ownershipEvidence: "Docker label io.prtisan.managed=true",
            action: "remove" as const,
          },
        ];
      });
  }

  private async worktrees(project: Project): Promise<CleanupCandidate[]> {
    const listed = await this.runner.run(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: project.cwd }
    );
    if (listed.exitCode !== 0) return [];
    const dataRoot = prtisanRepositoryDataPath(project.cwd);
    const records = parseWorktreePaths(listed.stdout);
    const candidates: CleanupCandidate[] = [];
    for (const path of records) {
      if (
        !path.startsWith(`${dataRoot}/`) &&
        !path.startsWith(
          `${resolvePath(project.cwd, ".sandcastle/worktrees")}/`
        )
      ) {
        continue;
      }
      const status = await this.runner.run(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: path }
      );
      const conversation = this.store
        .listConversations(project.id)
        .find((item) => path.includes(`/conversations/${item.id}/`));
      const head = await this.runner.run("git", ["rev-parse", "HEAD"], {
        cwd: path,
      });
      const active =
        conversation !== undefined &&
        (conversation.status === "running" ||
          this.store.hasActiveConversationTurn(conversation.id));
      const unpublished =
        conversation !== undefined &&
        (!conversation.publishedSha ||
          head.exitCode !== 0 ||
          head.stdout.trim() !== conversation.publishedSha);
      const dirty = status.exitCode !== 0 || status.stdout.trim().length > 0;
      const skipReason = active
        ? "Conversation has a queued or running Turn"
        : unpublished
          ? "Conversation has unpublished work"
          : dirty
            ? "worktree is dirty or unreadable"
            : undefined;
      candidates.push({
        id: `worktree:${path}`,
        category: "worktrees",
        projectId: project.id,
        ...(conversation ? { conversationId: conversation.id } : {}),
        description: `Managed worktree ${path}`,
        target: path,
        ownershipEvidence: `registered Git worktree beneath ${dataRoot}`,
        action: skipReason ? "skip" : "remove",
        ...(skipReason ? { reason: skipReason } : {}),
        estimatedBytes: await directorySize(this.runner, path),
      });
    }
    return candidates;
  }

  private async directories(
    project: Project,
    kind: "caches" | "logs"
  ): Promise<CleanupCandidate[]> {
    const roots =
      kind === "caches"
        ? [
            prtisanRepositoryDataPath(project.cwd, "cache"),
            prtisanRepositoryDataPath(project.cwd, "runtime"),
          ]
        : [
            prtisanRepositoryDataPath(project.cwd, "logs"),
            prtisanRepositoryDataPath(project.cwd, "runs"),
          ];
    const candidates: CleanupCandidate[] = [];
    for (const root of roots) {
      if (!(await pathIsDirectory(root))) continue;
      if (kind === "logs" && root.endsWith("/runs")) {
        for (const path of await findNamedDirectories(root, "logs")) {
          candidates.push(
            await directoryCandidate(project, kind, path, this.runner)
          );
        }
      } else {
        candidates.push(
          await directoryCandidate(project, kind, root, this.runner)
        );
      }
    }
    return candidates;
  }

  private async sessions(
    projects: readonly Project[],
    global: boolean
  ): Promise<CleanupCandidate[]> {
    if (!global) {
      return [
        {
          id: `sessions:shared:${projects[0]?.id ?? "unknown"}`,
          category: "sessions",
          projectId: projects[0]?.id,
          description: "Shared Codex sessions",
          target: joinPath(prtisanPaths().codexHome, "sessions"),
          ownershipEvidence: "Prtisan dedicated Codex home",
          action: "skip",
          reason: "sessions are shared across Projects; use global cleanup",
        },
      ];
    }
    const root = joinPath(prtisanPaths().codexHome, "sessions");
    if (!(await pathIsDirectory(root))) return [];
    const referenced = new Set(
      projects.flatMap((project) =>
        this.store
          .listConversations(project.id)
          .filter(
            (conversation) =>
              conversation.status !== "archived" &&
              conversation.status !== "published"
          )
          .map((conversation) => conversation.sessionId)
          .filter((id): id is string => Boolean(id))
      )
    );
    const files = await walkFiles(root);
    return Promise.all(
      files.map(async (path) => {
        const active = [...referenced].some((id) => path.includes(id));
        return {
          id: `session:${path}`,
          category: "sessions" as const,
          description: `Prtisan Codex session ${path}`,
          target: path,
          ownershipEvidence: "file beneath Prtisan dedicated Codex home",
          action: active ? ("skip" as const) : ("remove" as const),
          ...(active
            ? { reason: "session belongs to an active Conversation" }
            : {}),
          estimatedBytes: await fileSize(path),
        };
      })
    );
  }

  private async revalidate(
    candidate: CleanupCandidate
  ): Promise<CleanupCandidate> {
    if (candidate.category === "containers") {
      const inspect = await this.runner.run("docker", [
        "container",
        "inspect",
        candidate.target,
        '--format={{.State.Running}} {{ index .Config.Labels "io.prtisan.managed" }}',
      ]);
      if (inspect.exitCode !== 0) {
        return {
          ...candidate,
          action: "skip",
          reason: "container disappeared",
        };
      }
      if (inspect.stdout.trim() !== "false true") {
        return {
          ...candidate,
          action: "skip",
          reason: "container is active or ownership label changed",
        };
      }
    }
    if (candidate.category === "images") {
      const inspect = await this.runner.run("docker", [
        "image",
        "inspect",
        candidate.target,
        '--format={{ index .Config.Labels "io.prtisan.managed" }}',
      ]);
      if (inspect.exitCode !== 0 || inspect.stdout.trim() !== "true") {
        return {
          ...candidate,
          action: "skip",
          reason: "image disappeared or ownership label changed",
        };
      }
    }
    if (
      ["worktrees", "caches", "logs", "sessions"].includes(
        candidate.category
      ) &&
      !(await pathExists(candidate.target))
    ) {
      return { ...candidate, action: "skip", reason: "target disappeared" };
    }
    if (candidate.category === "worktrees" && candidate.projectId) {
      const project = this.store.project(candidate.projectId);
      if (!project) {
        return { ...candidate, action: "skip", reason: "Project disappeared" };
      }
      const status = await this.runner.run(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: candidate.target }
      );
      if (status.exitCode !== 0 || status.stdout.trim()) {
        return {
          ...candidate,
          action: "skip",
          reason: "worktree became dirty or unreadable",
        };
      }
      if (candidate.conversationId) {
        const conversation = this.store.conversation(candidate.conversationId);
        if (!conversation) {
          return {
            ...candidate,
            action: "skip",
            reason: "Conversation disappeared",
          };
        }
        if (
          conversation.status === "running" ||
          this.store.hasActiveConversationTurn(conversation.id)
        ) {
          return {
            ...candidate,
            action: "skip",
            reason: "Conversation has a queued or running Turn",
          };
        }
        const head = await this.runner.run("git", ["rev-parse", "HEAD"], {
          cwd: candidate.target,
        });
        if (
          !conversation.publishedSha ||
          head.exitCode !== 0 ||
          head.stdout.trim() !== conversation.publishedSha
        ) {
          return {
            ...candidate,
            action: "skip",
            reason: "Conversation has unpublished work",
          };
        }
      }
    }
    return candidate;
  }

  private async removeCandidate(candidate: CleanupCandidate): Promise<void> {
    if (candidate.category === "containers") {
      const removed = await this.runner.run("docker", [
        "container",
        "rm",
        candidate.target,
      ]);
      if (removed.exitCode !== 0)
        throw new Error(removed.stderr || removed.stdout);
      return;
    }
    if (candidate.category === "images") {
      const removed = await this.runner.run("docker", [
        "image",
        "rm",
        candidate.target,
      ]);
      if (removed.exitCode !== 0)
        throw new Error(removed.stderr || removed.stdout);
      return;
    }
    if (candidate.category === "worktrees" && candidate.projectId) {
      const project = this.requireProject(candidate.projectId);
      const removed = await this.runner.run(
        "git",
        ["worktree", "remove", candidate.target],
        { cwd: project.cwd }
      );
      if (removed.exitCode !== 0)
        throw new Error(removed.stderr || removed.stdout);
      await this.runner.run("git", ["worktree", "prune"], { cwd: project.cwd });
      return;
    }
    await rm(candidate.target, { recursive: true, force: true });
  }

  private requireProject(id: string): Project {
    const project = this.store.project(id);
    if (!project) throw new Error(`Unknown Project: ${id}.`);
    return project;
  }
}

function parseWorktreePaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function directoryCandidate(
  project: Project,
  category: "caches" | "logs",
  path: string,
  runner: CommandRunner
): Promise<CleanupCandidate> {
  return {
    id: `${category}:${path}`,
    category,
    projectId: project.id,
    description: `Prtisan ${category} at ${path}`,
    target: path,
    ownershipEvidence: "path beneath Prtisan repository data root",
    action: "remove",
    estimatedBytes: await directorySize(runner, path),
  };
}

async function directorySize(
  runner: CommandRunner,
  path: string
): Promise<number | undefined> {
  const result = await runner.run("du", ["-sk", path]);
  const kib = Number(result.stdout.trim().split(/\s+/)[0]);
  return result.exitCode === 0 && Number.isFinite(kib) ? kib * 1024 : undefined;
}

async function findNamedDirectories(
  root: string,
  name: string
): Promise<string[]> {
  const results: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = joinPath(path, entry.name);
      if (entry.name === name) results.push(child);
      else await visit(child);
    }
  }
  await visit(root);
  return results;
}

async function walkFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = joinPath(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) results.push(child);
    }
  }
  await visit(root);
  return results;
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}
