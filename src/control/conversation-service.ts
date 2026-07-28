import { stat } from "node:fs/promises";
import { z } from "zod";

import { BunCommandRunner, type CommandRunner, mustRun } from "@/exec.js";
import { ensureDir } from "@/fs.js";
import { joinPath } from "@/path.js";
import { prtisanPaths, prtisanRepositoryDataPath } from "@/prtisan-paths.js";
import { dockerfileContents } from "@/scaffold.js";
import { stableDigest } from "@/validation-hardening.js";

import { captureAttachments } from "./attachments.js";
import { ControlStore } from "./store.js";
import type {
  ActionProposal,
  Conversation,
  ConversationActivity,
  ConversationAttachment,
  ConversationMessage,
  ConversationTurnJobInput,
  Project,
  WorkerJob,
} from "./types.js";

const CONVERSATION_IMAGE = "prtisan/conversation:0.1";
const MANAGED_LABEL = "io.prtisan.managed=true";
const RESOURCE_KIND_LABEL = "io.prtisan.resource-kind=conversation";

const AgentResponseSchema = z.object({
  message: z.string().min(1),
  proposals: z
    .array(
      z.object({
        kind: z.enum([
          "setup_plan",
          "setup_apply",
          "policy_upgrade",
          "workflow_plan",
          "workflow_apply",
          "workflow_run",
          "workflow_export",
          "publish_pull_request",
          "cleanup",
        ]),
        title: z.string().min(1),
        payload: z.record(z.string(), z.unknown()).default({}),
      })
    )
    .default([]),
});

export interface ConversationTurnResult {
  readonly conversation: Conversation;
  readonly userMessage: ConversationMessage;
  readonly assistantMessage: ConversationMessage;
  readonly proposals: readonly ActionProposal[];
  readonly changedFiles: readonly string[];
  readonly checkpointSha: string;
}

export class ConversationService {
  private readonly active = new Map<string, Bun.Subprocess>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly store: ControlStore,
    private readonly runner: CommandRunner = new BunCommandRunner(),
    private readonly emit: (
      event: Readonly<Record<string, unknown>>
    ) => void = () => undefined
  ) {}

  async create(input: {
    readonly projectId: string;
    readonly title: string;
    readonly baseRef: string;
    readonly profile: Conversation["profile"];
  }): Promise<Conversation> {
    const project = this.requireProject(input.projectId);
    const resolved = await mustRun(
      this.runner,
      "git",
      ["rev-parse", "--verify", `${input.baseRef}^{commit}`],
      { cwd: project.cwd }
    );
    return this.store.createConversation({
      ...input,
      baseSha: resolved.stdout.trim(),
    });
  }

  enqueueTurn(input: {
    readonly conversationId: string;
    readonly text: string;
    readonly attachmentPaths?: readonly string[];
  }): WorkerJob {
    const conversation = this.requireConversation(input.conversationId);
    if (conversation.status === "archived") {
      throw new Error("Unarchive this Conversation before sending a turn.");
    }
    const project = this.requireProject(conversation.projectId);
    return this.store.createJob({
      projectId: project.id,
      conversationId: conversation.id,
      kind: "conversation_turn",
      input: {
        text: input.text,
        attachmentPaths: input.attachmentPaths ?? [],
      } satisfies ConversationTurnJobInput,
    });
  }

  async runTurn(jobId: string): Promise<ConversationTurnResult> {
    const queuedJob = this.store.job(jobId);
    if (
      !queuedJob ||
      queuedJob.kind !== "conversation_turn" ||
      !queuedJob.conversationId
    ) {
      throw new Error(`Unknown Conversation Turn job: ${jobId}.`);
    }
    const conversationId = queuedJob.conversationId;
    const job = this.store.claimQueuedJob(jobId);
    if (!job) throw new Error(`Conversation Turn job ${jobId} is not queued.`);
    const conversation = this.requireConversation(conversationId);
    const project = this.requireProject(conversation.projectId);
    let userMessage: ConversationMessage | undefined;

    let worktree = "";
    let before = "";
    try {
      const turnInput = decodeTurnJobInput(job.input);
      if (conversation.status === "archived") {
        throw new Error("Unarchive this Conversation before sending a turn.");
      }
      const attachments =
        turnInput.attachments ??
        (await captureAttachments(turnInput.attachmentPaths));
      userMessage = turnInput.messageId
        ? this.store
            .listMessages(conversation.id)
            .find((message) => message.id === turnInput.messageId)
        : undefined;
      userMessage ??= this.store.addMessage({
        conversationId: conversation.id,
        role: "user",
        text: turnInput.text,
        attachments,
      });
      const acceptedUserMessage = userMessage;
      this.store.updateJobInput(job.id, {
        ...turnInput,
        attachments,
        messageId: acceptedUserMessage.id,
      } satisfies ConversationTurnJobInput);
      this.store.updateConversation(conversation.id, { status: "running" });
      worktree = await this.ensureWorktree(project, conversation);
      before = (
        await mustRun(this.runner, "git", ["rev-parse", "HEAD"], {
          cwd: worktree,
        })
      ).stdout.trim();
      await this.ensureImage(project);
      const execution = await this.executeCodex({
        project,
        conversation,
        worktree,
        text: turnInput.text,
        attachments,
        transcript: this.store
          .listMessages(conversation.id)
          .filter((message) => message.id !== acceptedUserMessage.id),
      });
      const parsed = parseAgentResponse(execution.lastMessage);
      const changedFiles = await this.changedFiles(worktree);
      const checkpointSha = await this.checkpoint(
        worktree,
        conversation,
        changedFiles,
        before
      );
      const activities: ConversationActivity[] = [
        ...execution.activities,
        ...(changedFiles.length > 0
          ? [
              {
                type: "changed_files" as const,
                summary: `${changedFiles.length} file(s) changed`,
                detail: changedFiles,
              },
            ]
          : []),
      ];
      const assistantMessage = this.store.addMessage({
        conversationId: conversation.id,
        role: "assistant",
        text: parsed.message,
        events: activities,
      });
      const proposals = this.store.addProposals(
        assistantMessage.id,
        conversation.id,
        parsed.proposals.map((proposal) => ({
          ...proposal,
          preconditionDigest: stableDigest({
            projectId: project.id,
            conversationId: conversation.id,
            checkpointSha,
          }),
        }))
      );
      const updated = this.store.updateConversation(conversation.id, {
        status:
          conversation.pullRequestNumber === undefined ? "active" : "published",
        sessionId: execution.sessionId ?? conversation.sessionId,
      });
      const result = {
        conversation: updated,
        userMessage: acceptedUserMessage,
        assistantMessage,
        proposals,
        changedFiles,
        checkpointSha,
      };
      this.store.updateJob(job.id, "completed", result);
      return result;
    } catch (error) {
      if (worktree && before) await this.rollback(worktree, before);
      this.store.updateConversation(conversation.id, {
        status:
          conversation.pullRequestNumber === undefined ? "active" : "published",
      });
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = this.cancelled.delete(conversation.id);
      this.store.addMessage({
        conversationId: conversation.id,
        role: "system",
        text: cancelled
          ? "Turn cancelled by the operator and rolled back."
          : `Turn failed and was rolled back: ${message}`,
        status: cancelled ? "cancelled" : "failed",
      });
      this.store.updateJob(
        job.id,
        cancelled ? "cancelled" : "failed",
        undefined,
        message
      );
      throw error;
    } finally {
      this.active.delete(conversation.id);
    }
  }

  cancel(conversationId: string): boolean {
    const process = this.active.get(conversationId);
    if (!process) return false;
    this.cancelled.add(conversationId);
    process.kill();
    return true;
  }

  async publish(input: {
    readonly conversationId: string;
    readonly baseBranch: string;
    readonly draft?: boolean;
  }): Promise<Conversation> {
    const conversation = this.requireConversation(input.conversationId);
    const project = this.requireProject(conversation.projectId);
    const worktree = await this.ensureWorktree(project, conversation);
    const publishedSha = (
      await mustRun(this.runner, "git", ["rev-parse", "HEAD"], {
        cwd: worktree,
      })
    ).stdout.trim();
    await mustRun(
      this.runner,
      "git",
      ["push", "--set-upstream", "origin", conversation.branch],
      { cwd: worktree }
    );
    if (conversation.pullRequestNumber !== undefined) {
      return this.store.updateConversation(conversation.id, {
        status: "published",
        publishedSha,
      });
    }
    const body = [
      `Created from Prtisan Conversation ${conversation.id}.`,
      "",
      `Base snapshot: \`${conversation.baseSha}\``,
    ].join("\n");
    const args = [
      "pr",
      "create",
      "--head",
      conversation.branch,
      "--base",
      input.baseBranch,
      "--title",
      conversation.title,
      "--body",
      body,
    ];
    if (input.draft ?? true) args.push("--draft");
    const created = await mustRun(this.runner, "gh", args, {
      cwd: project.cwd,
    });
    const url = created.stdout.trim();
    if (!/^https:\/\/github\.com\//.test(url)) {
      throw new Error("GitHub did not return the created pull request URL.");
    }
    const viewed = await mustRun(
      this.runner,
      "gh",
      ["pr", "view", url, "--json", "number,url"],
      { cwd: project.cwd }
    );
    const value = JSON.parse(viewed.stdout) as {
      number?: unknown;
      url?: unknown;
    };
    if (typeof value.number !== "number" || typeof value.url !== "string") {
      throw new Error("GitHub returned incomplete pull request metadata.");
    }
    return this.store.updateConversation(conversation.id, {
      status: "published",
      pullRequestNumber: value.number,
      pullRequestUrl: value.url,
      publishedSha,
    });
  }

  private async ensureWorktree(
    project: Project,
    conversation: Conversation
  ): Promise<string> {
    const worktree = prtisanRepositoryDataPath(
      project.cwd,
      "conversations",
      conversation.id,
      "worktree"
    );
    if (await directoryExists(worktree)) return worktree;
    await ensureDir(joinPath(worktree, ".."));
    const branch = await this.runner.run(
      "git",
      ["show-ref", "--verify", `refs/heads/${conversation.branch}`],
      { cwd: project.cwd }
    );
    const args =
      branch.exitCode === 0
        ? ["worktree", "add", worktree, conversation.branch]
        : [
            "worktree",
            "add",
            "-b",
            conversation.branch,
            worktree,
            conversation.baseSha,
          ];
    await mustRun(this.runner, "git", args, { cwd: project.cwd });
    return worktree;
  }

  private async ensureImage(project: Project): Promise<void> {
    const inspected = await this.runner.run(
      "docker",
      [
        "image",
        "inspect",
        CONVERSATION_IMAGE,
        '--format={{ index .Config.Labels "io.prtisan.managed" }}',
      ],
      { cwd: project.cwd }
    );
    if (inspected.exitCode === 0 && inspected.stdout.trim() === "true") return;
    const source = dockerfileContents().replace(
      /^FROM ([^\n]+)$/m,
      [
        "FROM $1",
        'LABEL io.prtisan.managed="true"',
        'LABEL io.prtisan.resource-kind="conversation-image"',
      ].join("\n")
    );
    await mustRun(
      this.runner,
      "docker",
      ["build", "-t", CONVERSATION_IMAGE, "-f", "-", "."],
      { cwd: project.cwd, input: source, timeoutMs: 30 * 60 * 1000 }
    );
  }

  private async executeCodex(input: {
    readonly project: Project;
    readonly conversation: Conversation;
    readonly worktree: string;
    readonly text: string;
    readonly attachments: readonly ConversationAttachment[];
    readonly transcript: readonly ConversationMessage[];
  }): Promise<{
    readonly lastMessage: string;
    readonly sessionId?: string;
    readonly activities: readonly ConversationActivity[];
  }> {
    await ensureDir(prtisanPaths().codexHome);
    const initialPrompt = conversationPrompt(input.text, input.attachments);
    let execution = await this.runCodexContainer(
      input,
      input.conversation.sessionId,
      initialPrompt
    );
    let parsed = parseCodexEvents(execution.stdout, this.emit);
    if (
      execution.exitCode !== 0 &&
      input.conversation.sessionId &&
      /session|thread|resume|not found|missing/i.test(
        `${execution.stderr}\n${execution.stdout}`
      )
    ) {
      const recoveryPrompt = conversationPrompt(
        input.text,
        input.attachments,
        recoveryContext(input.conversation, input.transcript)
      );
      execution = await this.runCodexContainer(
        input,
        undefined,
        recoveryPrompt
      );
      parsed = parseCodexEvents(execution.stdout, this.emit);
    }
    if (execution.exitCode !== 0) {
      throw new Error(
        `Conversation agent failed (${execution.exitCode}): ${
          execution.stderr.trim() ||
          parsed.lastMessage ||
          execution.stdout.trim()
        }`
      );
    }
    return parsed;
  }

  private async runCodexContainer(
    input: {
      readonly project: Project;
      readonly conversation: Conversation;
      readonly worktree: string;
      readonly attachments: readonly ConversationAttachment[];
    },
    sessionId: string | undefined,
    prompt: string
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }> {
    const dockerArgs = buildConversationDockerArgs(
      {
        projectId: input.project.id,
        conversationId: input.conversation.id,
        profile: input.conversation.profile,
        worktree: input.worktree,
        codexHome: prtisanPaths().codexHome,
        attachments: input.attachments,
      },
      sessionId
    );
    const processHandle = Bun.spawn(["docker", ...dockerArgs], {
      cwd: input.project.cwd,
      env: Bun.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.active.set(input.conversation.id, processHandle);
    processHandle.stdin.write(prompt);
    processHandle.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  private async changedFiles(worktree: string): Promise<string[]> {
    const result = await mustRun(
      this.runner,
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: worktree }
    );
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
  }

  private async checkpoint(
    worktree: string,
    conversation: Conversation,
    changedFiles: readonly string[],
    before: string
  ): Promise<string> {
    if (changedFiles.length === 0) return before;
    await mustRun(this.runner, "git", ["add", "--all"], { cwd: worktree });
    await mustRun(
      this.runner,
      "git",
      [
        "-c",
        "user.name=Prtisan",
        "-c",
        "user.email=prtisan@localhost",
        "commit",
        "-m",
        `prtisan: checkpoint ${conversation.id.slice(0, 8)}`,
      ],
      { cwd: worktree }
    );
    return (
      await mustRun(this.runner, "git", ["rev-parse", "HEAD"], {
        cwd: worktree,
      })
    ).stdout.trim();
  }

  private async rollback(worktree: string, sha: string): Promise<void> {
    await this.runner.run("git", ["reset", "--hard", sha], { cwd: worktree });
    await this.runner.run("git", ["clean", "-fd"], { cwd: worktree });
  }

  private requireProject(id: string): Project {
    const project = this.store.project(id);
    if (!project) throw new Error(`Unknown Project: ${id}.`);
    return project;
  }

  private requireConversation(id: string): Conversation {
    const conversation = this.store.conversation(id);
    if (!conversation) throw new Error(`Unknown Conversation: ${id}.`);
    return conversation;
  }
}

export function buildConversationDockerArgs(
  input: {
    readonly projectId: string;
    readonly conversationId: string;
    readonly profile: Conversation["profile"];
    readonly worktree: string;
    readonly codexHome: string;
    readonly attachments: readonly ConversationAttachment[];
  },
  sessionId?: string
): string[] {
  const codexArgs = sessionId
    ? [
        "exec",
        "resume",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "-m",
        input.profile.model,
        "-c",
        `model_reasoning_effort="${input.profile.reasoningEffort}"`,
        sessionId,
        "-",
      ]
    : [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "-m",
        input.profile.model,
        "-c",
        `model_reasoning_effort="${input.profile.reasoningEffort}"`,
        "-",
      ];
  return [
    "run",
    "--rm",
    "--label",
    MANAGED_LABEL,
    "--label",
    RESOURCE_KIND_LABEL,
    "--label",
    `io.prtisan.project=${input.projectId}`,
    "--label",
    `io.prtisan.conversation=${input.conversationId}`,
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "-e",
    "HOME=/home/agent",
    "-e",
    "CODEX_HOME=/home/agent/.codex-prtisan",
    "-v",
    `${input.worktree}:/home/agent/workspace`,
    "-v",
    `${input.codexHome}:/home/agent/.codex-prtisan`,
    ...input.attachments.flatMap((attachment, index) => [
      "-v",
      `${attachment.path}:${containerAttachmentPath(attachment, index)}:ro`,
    ]),
    "-w",
    "/home/agent/workspace",
    CONVERSATION_IMAGE,
    "codex",
    ...codexArgs,
  ];
}

export function conversationPrompt(
  text: string,
  attachments: readonly ConversationAttachment[],
  recoveredContext?: string
): string {
  const attachmentText =
    attachments.length === 0
      ? "No explicit attachments."
      : attachments
          .map(
            (attachment, index) =>
              `- ${attachment.kind}: ${attachment.name} (${containerAttachmentPath(attachment, index)})`
          )
          .join("\n");
  return [
    "You are the interactive Prtisan coding agent.",
    "Work only inside the current isolated Git worktree.",
    "You may inspect and edit files, but do not push, open pull requests, start Prtisan workflows, or clean host resources.",
    "When an administrative action would help, propose it in the final response.",
    "Finish with one JSON object and no surrounding markdown:",
    '{"message":"human-readable response","proposals":[{"kind":"workflow_run","title":"Run Prtisan","payload":{}}]}',
    "Allowed proposal kinds: setup_plan, setup_apply, policy_upgrade, workflow_plan, workflow_apply, workflow_run, workflow_export, publish_pull_request, cleanup.",
    ...(recoveredContext
      ? [
          "",
          "The prior native Codex session was unavailable. Continue from this Prtisan-owned transcript context:",
          recoveredContext,
        ]
      : []),
    "",
    "Attachments:",
    attachmentText,
    "",
    "User:",
    text,
  ].join("\n");
}

function containerAttachmentPath(
  attachment: ConversationAttachment,
  index: number
): string {
  return `/home/agent/attachments/${index}-${attachment.digest}`;
}

function decodeTurnJobInput(value: unknown): ConversationTurnJobInput {
  if (!value || typeof value !== "object") {
    throw new Error("Conversation Turn job has invalid input.");
  }
  const input = value as Partial<ConversationTurnJobInput>;
  if (
    typeof input.text !== "string" ||
    !Array.isArray(input.attachmentPaths) ||
    !input.attachmentPaths.every((path) => typeof path === "string")
  ) {
    throw new Error("Conversation Turn job has invalid input.");
  }
  if (
    input.attachments !== undefined &&
    (!Array.isArray(input.attachments) ||
      !input.attachments.every(
        (attachment) =>
          attachment !== null &&
          typeof attachment === "object" &&
          typeof attachment.path === "string" &&
          typeof attachment.digest === "string"
      ))
  ) {
    throw new Error("Conversation Turn job has invalid attachments.");
  }
  return {
    text: input.text,
    attachmentPaths: input.attachmentPaths,
    ...(input.attachments
      ? { attachments: input.attachments as readonly ConversationAttachment[] }
      : {}),
    ...(typeof input.messageId === "string"
      ? { messageId: input.messageId }
      : {}),
  };
}

function recoveryContext(
  conversation: Conversation,
  transcript: readonly ConversationMessage[]
): string {
  const recent = transcript.slice(-12).map((message) => {
    const text =
      message.text.length > 4_000
        ? `${message.text.slice(0, 4_000)}…`
        : message.text;
    return `${message.role.toUpperCase()}: ${text}`;
  });
  return [
    ...(conversation.rollingSummary
      ? [`SUMMARY: ${conversation.rollingSummary}`]
      : []),
    ...recent,
  ].join("\n\n");
}

function parseAgentResponse(
  value: string
): z.infer<typeof AgentResponseSchema> {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1];
  for (const candidate of [trimmed, fenced]) {
    if (!candidate) continue;
    try {
      return AgentResponseSchema.parse(JSON.parse(candidate));
    } catch {
      // Try the final JSON object below.
    }
  }
  const start = trimmed.lastIndexOf("\n{");
  if (start >= 0) {
    try {
      return AgentResponseSchema.parse(JSON.parse(trimmed.slice(start + 1)));
    } catch {
      // Fall through to a plain response.
    }
  }
  return {
    message: trimmed || "The agent completed without a response.",
    proposals: [],
  };
}

function parseCodexEvents(
  output: string,
  emit: (event: Readonly<Record<string, unknown>>) => void
): {
  readonly lastMessage: string;
  readonly sessionId?: string;
  readonly activities: readonly ConversationActivity[];
} {
  let lastMessage = "";
  let sessionId: string | undefined;
  const activities: ConversationActivity[] = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    emit(event);
    const threadId = event.thread_id ?? event.session_id;
    if (typeof threadId === "string") sessionId = threadId;
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      lastMessage = item.text;
    }
    if (item?.type === "command_execution") {
      activities.push({
        type: "command",
        summary:
          typeof item.command === "string" ? item.command : "Agent command",
        detail: item,
      });
    }
    const eventType = typeof event.type === "string" ? event.type : "event";
    if (eventType.includes("error")) {
      activities.push({ type: "log", summary: eventType, detail: event });
    }
  }
  return { lastMessage, ...(sessionId ? { sessionId } : {}), activities };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
