import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { Database } from "bun:sqlite";

import { prtisanProjectKey } from "@/docker-ownership.js";
import type { CommandRunner } from "@/exec.js";
import { ensureDir } from "@/fs.js";
import { dirname } from "@/path.js";

import type {
  ActionProposal,
  Conversation,
  ConversationAttachment,
  ConversationMessage,
  ConversationProfile,
  Project,
  WorkerJob,
  WorkerJobStatus,
} from "./types.js";

export class ControlStore {
  private constructor(private readonly database: Database) {
    this.migrate();
  }

  static async open(path: string): Promise<ControlStore> {
    await ensureDir(dirname(path));
    return new ControlStore(new Database(path, { create: true }));
  }

  close(): void {
    this.database.close();
  }

  async addProject(
    inputPath: string,
    runner: CommandRunner,
    now = new Date()
  ): Promise<Project> {
    const root = await runner.run("git", ["rev-parse", "--show-toplevel"], {
      cwd: inputPath,
    });
    if (root.exitCode !== 0 || !root.stdout.trim()) {
      throw new Error(`${inputPath} is not a local Git repository.`);
    }
    const cwd = await realpath(root.stdout.trim());
    const id = projectId(cwd);
    const timestamp = now.toISOString();
    const remote = await runner.run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner"],
      { cwd }
    );
    let repository: string | undefined;
    if (remote.exitCode === 0) {
      try {
        const value = JSON.parse(remote.stdout) as { nameWithOwner?: unknown };
        if (typeof value.nameWithOwner === "string") {
          repository = value.nameWithOwner;
        }
      } catch {
        // GitHub is an optional Project capability.
      }
    }
    this.database
      .query(
        `INSERT INTO projects (
          id, cwd, name, repository, archived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(cwd) DO UPDATE SET
          name = excluded.name,
          repository = COALESCE(excluded.repository, projects.repository),
          archived = 0,
          updated_at = excluded.updated_at`
      )
      .run(id, cwd, basename(cwd), repository ?? null, timestamp, timestamp);
    return this.requireProject(id);
  }

  importProject(input: {
    readonly cwd: string;
    readonly repository?: string;
    readonly createdAt?: string;
  }): Project {
    const id = projectId(input.cwd);
    const timestamp = input.createdAt ?? new Date().toISOString();
    this.database
      .query(
        `INSERT OR IGNORE INTO projects (
          id, cwd, name, repository, archived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        input.cwd,
        basename(input.cwd),
        input.repository ?? null,
        timestamp,
        timestamp
      );
    return this.requireProject(id);
  }

  listProjects(options: { readonly archived?: boolean } = {}): Project[] {
    const rows =
      options.archived === undefined
        ? this.database
            .query<ProjectRow, []>(
              "SELECT * FROM projects ORDER BY archived, updated_at DESC"
            )
            .all()
        : this.database
            .query<ProjectRow, [number]>(
              "SELECT * FROM projects WHERE archived = ? ORDER BY updated_at DESC"
            )
            .all(options.archived ? 1 : 0);
    return rows.map(decodeProject);
  }

  project(id: string): Project | undefined {
    const row = this.database
      .query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?")
      .get(id);
    return row ? decodeProject(row) : undefined;
  }

  archiveProject(id: string, archived: boolean): Project {
    const result = this.database
      .query("UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?")
      .run(archived ? 1 : 0, new Date().toISOString(), id);
    if (result.changes === 0) throw new Error(`Unknown Project: ${id}.`);
    return this.requireProject(id);
  }

  createConversation(input: {
    readonly projectId: string;
    readonly title: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly profile: ConversationProfile;
    readonly now?: Date;
  }): Conversation {
    this.requireProject(input.projectId);
    const id = randomUUID();
    const timestamp = (input.now ?? new Date()).toISOString();
    const branch = `prtisan/conversation/${id}`;
    this.database
      .query(
        `INSERT INTO conversations (
          id, project_id, title, base_ref, base_sha, branch, profile_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.title.trim() || "New conversation",
        input.baseRef,
        input.baseSha,
        branch,
        JSON.stringify(input.profile),
        timestamp,
        timestamp
      );
    return this.requireConversation(id);
  }

  listConversations(projectId: string): Conversation[] {
    return this.database
      .query<ConversationRow, [string]>(
        "SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC"
      )
      .all(projectId)
      .map(decodeConversation);
  }

  conversation(id: string): Conversation | undefined {
    const row = this.database
      .query<ConversationRow, [string]>(
        "SELECT * FROM conversations WHERE id = ?"
      )
      .get(id);
    return row ? decodeConversation(row) : undefined;
  }

  updateConversation(
    id: string,
    patch: {
      readonly title?: string;
      readonly status?: Conversation["status"];
      readonly sessionId?: string | null;
      readonly pullRequestNumber?: number;
      readonly pullRequestUrl?: string;
      readonly publishedSha?: string;
      readonly rollingSummary?: string;
    }
  ): Conversation {
    const current = this.requireConversation(id);
    const next = {
      ...current,
      ...patch,
      sessionId:
        patch.sessionId === null
          ? undefined
          : (patch.sessionId ?? current.sessionId),
      updatedAt: new Date().toISOString(),
    };
    this.database
      .query(
        `UPDATE conversations SET
          title = ?, status = ?, session_id = ?, pull_request_number = ?,
          pull_request_url = ?, published_sha = ?, rolling_summary = ?,
          updated_at = ?
        WHERE id = ?`
      )
      .run(
        next.title,
        next.status,
        next.sessionId ?? null,
        next.pullRequestNumber ?? null,
        next.pullRequestUrl ?? null,
        next.publishedSha ?? null,
        next.rollingSummary ?? null,
        next.updatedAt,
        id
      );
    return this.requireConversation(id);
  }

  addMessage(input: {
    readonly conversationId: string;
    readonly role: ConversationMessage["role"];
    readonly text: string;
    readonly status?: ConversationMessage["status"];
    readonly attachments?: readonly ConversationAttachment[];
    readonly events?: ConversationMessage["events"];
    readonly now?: Date;
  }): ConversationMessage {
    this.requireConversation(input.conversationId);
    const id = randomUUID();
    const createdAt = (input.now ?? new Date()).toISOString();
    this.database
      .query(
        `INSERT INTO messages (
          id, conversation_id, role, text, status, attachments_json,
          events_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.role,
        input.text,
        input.status ?? "completed",
        JSON.stringify(input.attachments ?? []),
        JSON.stringify(input.events ?? []),
        createdAt
      );
    this.database
      .query("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(createdAt, input.conversationId);
    return this.requireMessage(id);
  }

  listMessages(conversationId: string): ConversationMessage[] {
    return this.database
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid"
      )
      .all(conversationId)
      .map(decodeMessage);
  }

  addProposals(
    messageId: string,
    conversationId: string,
    proposals: readonly Omit<
      ActionProposal,
      "id" | "messageId" | "conversationId" | "status" | "createdAt"
    >[]
  ): ActionProposal[] {
    const createdAt = new Date().toISOString();
    return proposals.map((proposal) => {
      const id = randomUUID();
      this.database
        .query(
          `INSERT INTO proposals (
            id, conversation_id, message_id, kind, title, payload_json,
            precondition_digest, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        )
        .run(
          id,
          conversationId,
          messageId,
          proposal.kind,
          proposal.title,
          JSON.stringify(proposal.payload),
          proposal.preconditionDigest,
          createdAt
        );
      return {
        ...proposal,
        id,
        conversationId,
        messageId,
        status: "pending",
        createdAt,
      };
    });
  }

  listProposals(conversationId: string): ActionProposal[] {
    return this.database
      .query<ProposalRow, [string]>(
        "SELECT * FROM proposals WHERE conversation_id = ? ORDER BY created_at, rowid"
      )
      .all(conversationId)
      .map(decodeProposal);
  }

  proposal(id: string): ActionProposal | undefined {
    const row = this.database
      .query<ProposalRow, [string]>("SELECT * FROM proposals WHERE id = ?")
      .get(id);
    return row ? decodeProposal(row) : undefined;
  }

  updateProposal(id: string, status: ActionProposal["status"]): ActionProposal {
    const changed = this.database
      .query("UPDATE proposals SET status = ? WHERE id = ?")
      .run(status, id);
    if (changed.changes === 0) throw new Error(`Unknown proposal: ${id}.`);
    const proposal = this.proposal(id);
    if (!proposal) throw new Error(`Unknown proposal: ${id}.`);
    return proposal;
  }

  createJob(input: {
    readonly projectId?: string;
    readonly conversationId?: string;
    readonly kind: WorkerJob["kind"];
    readonly input: unknown;
  }): WorkerJob {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO jobs (
          id, project_id, conversation_id, kind, status, input_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`
      )
      .run(
        id,
        input.projectId ?? null,
        input.conversationId ?? null,
        input.kind,
        JSON.stringify(input.input ?? null),
        timestamp,
        timestamp
      );
    return this.requireJob(id);
  }

  updateJob(
    id: string,
    status: WorkerJobStatus,
    result?: unknown,
    error?: string
  ): WorkerJob {
    const updatedAt = new Date().toISOString();
    const changed = this.database
      .query(
        "UPDATE jobs SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        status,
        result === undefined ? null : JSON.stringify(result),
        error ?? null,
        updatedAt,
        id
      );
    if (changed.changes === 0) throw new Error(`Unknown job: ${id}.`);
    return this.requireJob(id);
  }

  updateJobInput(id: string, input: unknown): WorkerJob {
    const changed = this.database
      .query("UPDATE jobs SET input_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(input), new Date().toISOString(), id);
    if (changed.changes === 0) throw new Error(`Unknown job: ${id}.`);
    return this.requireJob(id);
  }

  job(id: string): WorkerJob | undefined {
    const row = this.database
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?")
      .get(id);
    return row ? decodeJob(row) : undefined;
  }

  listJobs(
    input: {
      readonly kind?: WorkerJob["kind"];
      readonly statuses?: readonly WorkerJobStatus[];
    } = {}
  ): WorkerJob[] {
    const rows = this.database
      .query<JobRow, []>("SELECT * FROM jobs ORDER BY created_at, rowid")
      .all();
    const statuses = input.statuses
      ? new Set<WorkerJobStatus>(input.statuses)
      : undefined;
    return rows
      .filter((row) => input.kind === undefined || row.kind === input.kind)
      .filter((row) => statuses === undefined || statuses.has(row.status))
      .map(decodeJob);
  }

  claimQueuedJob(id: string): WorkerJob | undefined {
    const changed = this.database
      .query(
        "UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'"
      )
      .run(new Date().toISOString(), id);
    return changed.changes === 0 ? undefined : this.requireJob(id);
  }

  hasActiveConversationTurn(conversationId: string): boolean {
    return (
      this.database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM jobs
           WHERE conversation_id = ? AND kind = 'conversation_turn'
             AND status IN ('queued', 'running')`
        )
        .get(conversationId)?.count !== 0
    );
  }

  interruptRunningJobs(): number {
    return this.database
      .query(
        "UPDATE jobs SET status = 'interrupted', updated_at = ? WHERE status = 'running'"
      )
      .run(new Date().toISOString()).changes;
  }

  private requireProject(id: string): Project {
    const project = this.project(id);
    if (!project) throw new Error(`Unknown Project: ${id}.`);
    return project;
  }

  private requireConversation(id: string): Conversation {
    const conversation = this.conversation(id);
    if (!conversation) throw new Error(`Unknown Conversation: ${id}.`);
    return conversation;
  }

  private requireMessage(id: string): ConversationMessage {
    const row = this.database
      .query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?")
      .get(id);
    if (!row) throw new Error(`Unknown message: ${id}.`);
    return decodeMessage(row);
  }

  private requireJob(id: string): WorkerJob {
    const row = this.database
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?")
      .get(id);
    if (!row) throw new Error(`Unknown job: ${id}.`);
    return decodeJob(row);
  }

  private migrate(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        repository TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        branch TEXT NOT NULL UNIQUE,
        profile_json TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        pull_request_number INTEGER,
        pull_request_url TEXT,
        published_sha TEXT,
        rolling_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        events_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        message_id TEXT NOT NULL REFERENCES messages(id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        precondition_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        conversation_id TEXT REFERENCES conversations(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_project_updated
        ON conversations(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS messages_conversation_created
        ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS jobs_status_created
        ON jobs(status, created_at);
    `);
    this.ensureColumn("conversations", "published_sha", "TEXT");
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all();
    if (!columns.some((item) => item.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

interface ProjectRow {
  readonly id: string;
  readonly cwd: string;
  readonly name: string;
  readonly repository: string | null;
  readonly archived: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ConversationRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly base_ref: string;
  readonly base_sha: string;
  readonly branch: string;
  readonly profile_json: string;
  readonly status: Conversation["status"];
  readonly session_id: string | null;
  readonly pull_request_number: number | null;
  readonly pull_request_url: string | null;
  readonly published_sha: string | null;
  readonly rolling_summary: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly role: ConversationMessage["role"];
  readonly text: string;
  readonly status: ConversationMessage["status"];
  readonly attachments_json: string;
  readonly events_json: string;
  readonly created_at: string;
}

interface JobRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly conversation_id: string | null;
  readonly kind: WorkerJob["kind"];
  readonly status: WorkerJob["status"];
  readonly input_json: string;
  readonly result_json: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ProposalRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly message_id: string;
  readonly kind: ActionProposal["kind"];
  readonly title: string;
  readonly payload_json: string;
  readonly precondition_digest: string;
  readonly status: ActionProposal["status"];
  readonly created_at: string;
}

function decodeProject(row: ProjectRow): Project {
  return {
    id: row.id,
    cwd: row.cwd,
    name: row.name,
    ...(row.repository ? { repository: row.repository } : {}),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    branch: row.branch,
    profile: JSON.parse(row.profile_json) as ConversationProfile,
    status: row.status,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.pull_request_number
      ? { pullRequestNumber: row.pull_request_number }
      : {}),
    ...(row.pull_request_url ? { pullRequestUrl: row.pull_request_url } : {}),
    ...(row.published_sha ? { publishedSha: row.published_sha } : {}),
    ...(row.rolling_summary ? { rollingSummary: row.rolling_summary } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    text: row.text,
    status: row.status,
    attachments: JSON.parse(
      row.attachments_json
    ) as readonly ConversationAttachment[],
    events: JSON.parse(row.events_json) as ConversationMessage["events"],
    createdAt: row.created_at,
  };
}

function decodeJob(row: JobRow): WorkerJob {
  return {
    id: row.id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    kind: row.kind,
    status: row.status,
    input: JSON.parse(row.input_json) as unknown,
    ...(row.result_json
      ? { result: JSON.parse(row.result_json) as unknown }
      : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeProposal(row: ProposalRow): ActionProposal {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    kind: row.kind,
    title: row.title,
    payload: JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>,
    preconditionDigest: row.precondition_digest,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function projectId(cwd: string): string {
  return prtisanProjectKey(cwd);
}
