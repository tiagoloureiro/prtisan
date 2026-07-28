import { chmod, open, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { Database } from "bun:sqlite";

import { type CleanupExecutionRequest, PrtisanCleanup } from "@/cleanup.js";
import { executeInit, initSummary } from "@/commands/init.js";
import { ConversationService } from "@/control/conversation-service.js";
import { loadGlobalSettings } from "@/control/settings.js";
import { ControlStore } from "@/control/store.js";
import { BunCommandRunner } from "@/exec.js";
import { ensureDir } from "@/fs.js";
import { GitHubClient } from "@/github.js";
import { dirname } from "@/path.js";
import { prtisanPaths, prtisanRepositoryDataPath } from "@/prtisan-paths.js";
import {
  assertSetupPlanFresh,
  createSetupPlan,
  SetupPlanStore,
} from "@/setup-plan.js";
import { stableDigest } from "@/validation-hardening.js";
import { FileArtifactStore } from "@/workflow/artifacts.js";
import { SqliteWorkflowJournal } from "@/workflow/journal.js";
import { ProductionWorkflowEnvironment } from "@/workflow/production.js";
import { PrtisanWorkflow } from "@/workflow/workflow.js";

import { ConversationLocks } from "./conversation-lock.js";
import type { WorkerEvent, WorkerRequest, WorkerResponse } from "./protocol.js";
import { ConversationTurnScheduler } from "./turn-scheduler.js";

export async function runWorkerServer(): Promise<void> {
  const paths = prtisanPaths();
  await ensureDir(dirname(paths.workerSocket));
  await ensureDir(dirname(paths.workerLock));
  const lock = await acquireWorkerLock(paths.workerLock);
  if (!lock) return;
  await rm(paths.workerSocket, { force: true });
  const store = await ControlStore.open(paths.control);
  backfillProjects(store, paths.journal);
  store.interruptRunningJobs();
  const settings = await loadGlobalSettings();
  const runner = new BunCommandRunner();
  await recoverInterruptedConversations(store, runner);
  const clients = new Set<Socket>();
  const broadcast = (event: WorkerEvent) => {
    const frame = `${JSON.stringify(event)}\n`;
    for (const client of clients) client.write(frame);
  };
  const conversations = new ConversationService(store, runner, (data) =>
    broadcast({ event: "conversation.activity", data })
  );
  const conversationLocks = new ConversationLocks();
  const cleanup = new PrtisanCleanup(
    store,
    runner,
    (conversationId, operation) =>
      conversationLocks.run(conversationId, operation)
  );
  const turns = new ConversationTurnScheduler(
    store,
    conversations,
    conversationLocks,
    settings.maxConcurrentTurns ?? 1
  );
  turns.restore();
  let lastActivity = Date.now();
  let activeRequests = 0;

  const server = createServer((socket) => {
    clients.add(socket);
    lastActivity = Date.now();
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let request: WorkerRequest;
        try {
          request = JSON.parse(line) as WorkerRequest;
        } catch {
          continue;
        }
        activeRequests += 1;
        lastActivity = Date.now();
        void dispatch(request)
          .then((result) => send(socket, { id: request.id, ok: true, result }))
          .catch((error) =>
            send(socket, {
              id: request.id,
              ok: false,
              error: serializeError(error),
            })
          )
          .finally(() => {
            activeRequests -= 1;
            lastActivity = Date.now();
          });
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  async function dispatch(request: WorkerRequest): Promise<unknown> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "ping":
        return { pid: process.pid, started: true };
      case "project.list":
        return store.listProjects({
          archived:
            typeof params.archived === "boolean" ? params.archived : undefined,
        });
      case "project.add":
        return store.addProject(String(params.cwd ?? "."), runner);
      case "project.archive":
        return store.archiveProject(
          String(params.projectId),
          Boolean(params.archived ?? true)
        );
      case "project.capabilities":
        return projectCapabilities(String(params.projectId));
      case "conversation.list":
        return store.listConversations(String(params.projectId));
      case "conversation.messages":
        return store.listMessages(String(params.conversationId));
      case "proposal.list":
        return store.listProposals(String(params.conversationId));
      case "proposal.confirm":
        return confirmProposal(String(params.proposalId));
      case "proposal.reject":
        return store.updateProposal(String(params.proposalId), "rejected");
      case "conversation.create":
        return conversations.create({
          projectId: String(params.projectId),
          title: String(params.title ?? "New conversation"),
          baseRef: String(params.baseRef ?? "HEAD"),
          profile: params.profile as Parameters<
            ConversationService["create"]
          >[0]["profile"],
        });
      case "conversation.archive":
        return store.updateConversation(String(params.conversationId), {
          status: (params.archived ?? true) ? "archived" : "active",
        });
      case "conversation.send":
        return turns.submit({
          conversationId: String(params.conversationId),
          text: String(params.text ?? ""),
          attachmentPaths: Array.isArray(params.attachmentPaths)
            ? params.attachmentPaths.map(String)
            : [],
        });
      case "conversation.cancel":
        return {
          cancelled: conversations.cancel(String(params.conversationId)),
        };
      case "conversation.publish":
        return publishConversation({
          conversationId: String(params.conversationId),
          baseBranch: String(params.baseBranch),
          draft: params.draft === undefined ? true : Boolean(params.draft),
        });
      case "cleanup.preview":
        return cleanup.preview({
          projectId:
            typeof params.projectId === "string" ? params.projectId : undefined,
          all: !!params.all,
          categories: Array.isArray(params.categories)
            ? (params.categories as Parameters<
                PrtisanCleanup["preview"]
              >[0]["categories"])
            : undefined,
        });
      case "cleanup.execute":
        return cleanup.execute({
          authorizationId: String(params.authorizationId ?? ""),
          candidateIds: Array.isArray(params.candidateIds)
            ? params.candidateIds.map(String)
            : [],
        } satisfies CleanupExecutionRequest);
      case "workflow.run":
      case "workflow.plan":
      case "workflow.apply":
      case "workflow.status":
      case "workflow.export":
        return executeWorkflow(
          request.method.slice("workflow.".length),
          params
        );
      case "setup.plan":
        return executeSetupPlan(String(params.cwd ?? "."));
      case "setup.apply":
        return executeSetupApply(String(params.id));
      default:
        throw new Error(`Unknown Worker method: ${request.method}.`);
    }
  }

  async function executeWorkflow(
    action: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const journal = await SqliteWorkflowJournal.open(paths.journal);
    try {
      const workflow = new PrtisanWorkflow(
        journal,
        new FileArtifactStore(paths.artifacts),
        new ProductionWorkflowEnvironment(runner)
      );
      if (action === "run") {
        return workflow.run({ cwd: String(params.cwd ?? ".") });
      }
      if (action === "plan") {
        return workflow.plan({ cwd: String(params.cwd ?? ".") });
      }
      const id = String(params.id);
      if (action === "apply") return workflow.apply(id);
      if (action === "status") return workflow.status(id);
      if (action === "export") return workflow.export(id);
      throw new Error(`Unknown workflow action: ${action}.`);
    } finally {
      journal.close();
    }
  }

  async function publishConversation(
    input: Parameters<ConversationService["publish"]>[0]
  ): Promise<unknown> {
    return conversationLocks.run(input.conversationId, () =>
      conversations.publish(input)
    );
  }

  async function projectCapabilities(projectId: string): Promise<unknown> {
    const project = store.project(projectId);
    if (!project) throw new Error(`Unknown Project: ${projectId}.`);
    const [docker, githubAuth, github, setup] = await Promise.all([
      runner.run("docker", ["info", "--format={{.ServerVersion}}"]),
      runner.run("gh", ["auth", "status"], { cwd: project.cwd }),
      runner.run("gh", ["repo", "view", "--json", "nameWithOwner"], {
        cwd: project.cwd,
      }),
      runner.run("git", ["show", "HEAD:.prtisan/manifest.json"], {
        cwd: project.cwd,
      }),
    ]);
    return [
      {
        capability: "docker",
        available: docker.exitCode === 0,
        details:
          docker.exitCode === 0
            ? `Docker ${docker.stdout.trim()}`
            : docker.stderr.trim() || "Docker is unavailable",
      },
      {
        capability: "github_auth",
        available: githubAuth.exitCode === 0,
        details:
          githubAuth.exitCode === 0
            ? "GitHub CLI authenticated"
            : githubAuth.stderr.trim() || "GitHub CLI authentication required",
      },
      {
        capability: "github",
        available: github.exitCode === 0,
        details:
          github.exitCode === 0
            ? "GitHub repository available"
            : github.stderr.trim() || "No accessible GitHub remote",
      },
      {
        capability: "prtisan_setup",
        available: setup.exitCode === 0,
        details:
          setup.exitCode === 0
            ? "Prtisan manifest found"
            : "Prtisan setup has not been merged",
      },
    ];
  }

  async function executeSetupPlan(cwd: string): Promise<unknown> {
    const plan = await createSetupPlan({ cwd, runner });
    const plans = await SetupPlanStore.open(paths.journal);
    try {
      plans.save(plan);
    } finally {
      plans.close();
    }
    return plan;
  }

  async function executeSetupApply(id: string): Promise<unknown> {
    const plans = await SetupPlanStore.open(paths.journal);
    try {
      const plan = plans.load(id);
      if (!plan) throw new Error(`Unknown Prtisan setup plan: ${id}.`);
      await assertSetupPlanFresh(plan, runner);
      const result = await executeInit(
        {
          cwd: plan.cwd,
          repo: plan.repo,
          targetBranch: plan.targetBranch,
          branch: plan.branch,
          manifest: plan.proposedManifest,
          force: plan.upgrade,
        },
        {
          runner,
          github: new GitHubClient(runner, plan.cwd),
          log: console.error,
        }
      );
      return initSummary(result);
    } finally {
      plans.close();
    }
  }

  async function confirmProposal(id: string): Promise<unknown> {
    const proposal = store.proposal(id);
    if (!proposal) throw new Error(`Unknown Action proposal: ${id}.`);
    if (proposal.status !== "pending") {
      throw new Error(`Action proposal ${id} is already ${proposal.status}.`);
    }
    const conversation = store.conversation(proposal.conversationId);
    if (!conversation)
      throw new Error("The proposal's Conversation is missing.");
    const project = store.project(conversation.projectId);
    if (!project) throw new Error("The proposal's Project is missing.");
    const head = await runner.run(
      "git",
      ["rev-parse", "--verify", conversation.branch],
      { cwd: project.cwd }
    );
    const checkpointSha =
      head.exitCode === 0 ? head.stdout.trim() : conversation.baseSha;
    const digest = stableDigest({
      projectId: project.id,
      conversationId: conversation.id,
      checkpointSha,
    });
    if (digest !== proposal.preconditionDigest) {
      store.updateProposal(id, "stale");
      throw new Error(
        "The Project changed after this action was proposed. Ask the agent for a fresh proposal."
      );
    }
    store.updateProposal(id, "confirmed");
    const payload = proposal.payload;
    let result: unknown;
    if (proposal.kind === "setup_plan" || proposal.kind === "policy_upgrade") {
      result = await executeSetupPlan(project.cwd);
    } else if (proposal.kind === "setup_apply") {
      result = await executeSetupApply(String(payload.planId ?? payload.id));
    } else if (proposal.kind === "workflow_plan") {
      result = await executeWorkflow("plan", { cwd: project.cwd });
    } else if (proposal.kind === "workflow_apply") {
      result = await executeWorkflow("apply", {
        id: payload.planId ?? payload.id,
      });
    } else if (proposal.kind === "workflow_run") {
      result = await executeWorkflow("run", { cwd: project.cwd });
    } else if (proposal.kind === "workflow_export") {
      result = await executeWorkflow("export", {
        id: payload.planId ?? payload.id,
      });
    } else if (proposal.kind === "publish_pull_request") {
      result = await publishConversation({
        conversationId: conversation.id,
        baseBranch: String(payload.baseBranch ?? "main"),
        draft: payload.draft === undefined ? true : !!payload.draft,
      });
    } else if (proposal.kind === "cleanup") {
      const preview = await cleanup.preview({
        projectId: payload.all ? undefined : project.id,
        all: !!payload.all,
        categories: Array.isArray(payload.categories)
          ? (payload.categories as Parameters<
              PrtisanCleanup["preview"]
            >[0]["categories"])
          : undefined,
      });
      result = await cleanup.execute({
        authorizationId: preview.authorizationId,
        candidateIds: preview.candidates
          .filter((candidate) => candidate.action === "remove")
          .map((candidate) => candidate.id),
      });
    } else {
      throw new Error(`Unsupported Action proposal kind: ${proposal.kind}.`);
    }
    store.updateProposal(id, "completed");
    return result;
  }

  try {
    await listen(server, paths.workerSocket);
    await chmod(paths.workerSocket, 0o600);
    const idleTimer = setInterval(
      () => {
        if (
          activeRequests === 0 &&
          !turns.busy &&
          clients.size === 0 &&
          Date.now() - lastActivity >= settings.workerIdleTimeoutMs
        ) {
          clearInterval(idleTimer);
          server.close();
        }
      },
      Math.min(30_000, settings.workerIdleTimeoutMs)
    );
    await new Promise<void>((resolve) => server.once("close", resolve));
  } finally {
    store.close();
    await rm(paths.workerSocket, { force: true });
    await lock.close();
    await rm(paths.workerLock, { force: true });
  }
}

function backfillProjects(store: ControlStore, journalPath: string): void {
  try {
    const database = new Database(journalPath, { readonly: true });
    try {
      const exists = database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'plans'"
        )
        .get()?.count;
      if (!exists) return;
      for (const row of database
        .query<{ plan_json: string }, []>("SELECT plan_json FROM plans")
        .all()) {
        const plan = JSON.parse(row.plan_json) as {
          cwd?: unknown;
          repo?: unknown;
          createdAt?: unknown;
        };
        if (typeof plan.cwd !== "string") continue;
        store.importProject({
          cwd: plan.cwd,
          ...(typeof plan.repo === "string" ? { repository: plan.repo } : {}),
          ...(typeof plan.createdAt === "string"
            ? { createdAt: plan.createdAt }
            : {}),
        });
      }
    } finally {
      database.close();
    }
  } catch {
    // A fresh installation may not have a workflow journal yet.
  }
}

function send(socket: Socket, response: WorkerResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function serializeError(error: unknown): {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
} {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function acquireWorkerLock(
  path: string
): Promise<Awaited<ReturnType<typeof open>> | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return handle;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const owner = Number(
        (await readFile(path, "utf8").catch(() => "")).trim()
      );
      if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) {
        return undefined;
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("Unable to acquire the Prtisan Worker lock.");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function recoverInterruptedConversations(
  store: ControlStore,
  runner: BunCommandRunner
): Promise<void> {
  for (const project of store.listProjects()) {
    for (const conversation of store
      .listConversations(project.id)
      .filter((item) => item.status === "running")) {
      const worktree = prtisanRepositoryDataPath(
        project.cwd,
        "conversations",
        conversation.id,
        "worktree"
      );
      try {
        await runner.run("git", ["reset", "--hard", "HEAD"], {
          cwd: worktree,
        });
        await runner.run("git", ["clean", "-fd"], { cwd: worktree });
      } catch {
        // A missing worktree has no partial filesystem edits to preserve.
      }
      store.updateConversation(conversation.id, {
        status:
          conversation.pullRequestNumber === undefined ? "active" : "published",
      });
      store.addMessage({
        conversationId: conversation.id,
        role: "system",
        text: "The Worker restarted during this Turn. Partial edits were rolled back; retry explicitly to continue.",
        status: "interrupted",
      });
    }
  }
}
