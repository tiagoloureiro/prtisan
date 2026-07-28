/** @jsxImportSource @opentui/react */
import type { SelectOption, TextareaRenderable } from "@opentui/core";
import { createCliRenderer } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CleanupPreview, CleanupResult } from "@/cleanup.js";
import { loadGlobalSettings } from "@/control/settings.js";
import type {
  ActionProposal,
  Conversation,
  ConversationMessage,
  GlobalSettings,
  Project,
  ProjectCapabilityStatus,
} from "@/control/types.js";
import { joinPath } from "@/path.js";
import { WorkerClient } from "@/worker/client.js";
import type { WorkerEvent } from "@/worker/protocol.js";
import type { WorkflowRunResult } from "@/workflow/workflow.js";

export interface TuiClient {
  request<T>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (event: WorkerEvent) => void): () => void;
}

export async function runTui(input: { readonly cwd: string }): Promise<void> {
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    onDestroy: resolveExit,
  });
  const client = new WorkerClient();
  await client.connect({ start: true });
  createRoot(renderer).render(<PrtisanApp client={client} cwd={input.cwd} />);
  await exited;
  client.close();
}

export function PrtisanApp({
  client,
  cwd,
}: {
  readonly client: TuiClient;
  readonly cwd: string;
}) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<Conversation>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [proposals, setProposals] = useState<ActionProposal[]>([]);
  const [settings, setSettings] = useState<GlobalSettings>();
  const [capabilities, setCapabilities] = useState<ProjectCapabilityStatus[]>(
    []
  );
  const [focus, setFocus] = useState<
    "projects" | "conversations" | "composer" | "command"
  >("projects");
  const [commandOpen, setCommandOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Connecting to Prtisan Worker…");
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview>();
  const [pendingAttachments, setPendingAttachments] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<
    | { readonly kind: "run"; readonly project: Project }
    | {
        readonly kind: "publish";
        readonly conversation: Conversation;
        readonly baseBranch: string;
      }
  >();
  const composer = useRef<TextareaRenderable>(null);

  const refreshProjects = useCallback(async () => {
    const current = await client.request<Project>("project.add", { cwd });
    const all = await client.request<Project[]>("project.list", {
      archived: false,
    });
    setProjects(all);
    setProject(
      (selected) =>
        all.find((item) => item.id === selected?.id) ??
        all.find((item) => item.id === current.id) ??
        all[0]
    );
    setSettings(await loadGlobalSettings());
    setNotice("Ready");
  }, [client, cwd]);

  const refreshConversations = useCallback(async () => {
    if (!project) {
      setConversations([]);
      setConversation(undefined);
      return;
    }
    const all = await client.request<Conversation[]>("conversation.list", {
      projectId: project.id,
    });
    setConversations(all);
    setConversation(
      (selected) => all.find((item) => item.id === selected?.id) ?? all[0]
    );
  }, [client, project]);

  const refreshMessages = useCallback(async () => {
    if (!conversation) {
      setMessages([]);
      setProposals([]);
      return;
    }
    const [nextMessages, nextProposals] = await Promise.all([
      client.request<ConversationMessage[]>("conversation.messages", {
        conversationId: conversation.id,
      }),
      client.request<ActionProposal[]>("proposal.list", {
        conversationId: conversation.id,
      }),
    ]);
    setMessages(nextMessages);
    setProposals(nextProposals);
  }, [client, conversation]);

  useEffect(() => {
    void refreshProjects().catch((error) => setNotice(errorMessage(error)));
  }, [refreshProjects]);

  useEffect(() => {
    void refreshConversations().catch((error) =>
      setNotice(errorMessage(error))
    );
    if (project) {
      void client
        .request<ProjectCapabilityStatus[]>("project.capabilities", {
          projectId: project.id,
        })
        .then(setCapabilities)
        .catch(() => setCapabilities([]));
    } else {
      setCapabilities([]);
    }
  }, [client, project, refreshConversations]);

  useEffect(() => {
    void refreshMessages().catch((error) => setNotice(errorMessage(error)));
  }, [refreshMessages]);

  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.event === "conversation.activity") {
          const data = event.data as { type?: unknown };
          setNotice(
            typeof data.type === "string"
              ? `Agent: ${data.type}`
              : "Agent working…"
          );
        }
      }),
    [client]
  );

  const runCommand = useCallback(
    async (raw: string) => {
      const [name, ...rest] = raw.trim().split(/\s+/);
      setCommandOpen(false);
      setFocus("composer");
      if (!name) return;
      setBusy(true);
      try {
        if (name === "add") {
          if (!rest[0]) throw new Error("Usage: add /path/to/repository");
          await client.request("project.add", { cwd: rest.join(" ") });
          await refreshProjects();
          setNotice("Project added");
        } else if (name === "new") {
          if (!project || !settings) throw new Error("Select a Project first.");
          const created = await client.request<Conversation>(
            "conversation.create",
            {
              projectId: project.id,
              title: rest.join(" ") || "New conversation",
              baseRef: "HEAD",
              profile: settings.defaultConversationProfile,
            }
          );
          await refreshConversations();
          setConversation(created);
          setNotice("Conversation created from HEAD");
        } else if (name === "run") {
          if (!project) throw new Error("Select a Project first.");
          setPendingAction({ kind: "run", project });
          setNotice(
            `Start or resume Prtisan for ${project.name}? Press y to confirm or n to cancel.`
          );
        } else if (name === "cleanup") {
          if (!project) throw new Error("Select a Project first.");
          const preview = await client.request<CleanupPreview>(
            "cleanup.preview",
            { projectId: project.id, all: false }
          );
          setCleanupPreview(preview);
          setNotice(
            `Cleanup preview: ${preview.candidates.filter((item) => item.action === "remove").length} removable. Press y to confirm or n to cancel.`
          );
        } else if (name === "publish") {
          if (!conversation) throw new Error("Select a Conversation first.");
          const baseBranch = rest[0] ?? "main";
          setPendingAction({
            kind: "publish",
            conversation,
            baseBranch,
          });
          setNotice(
            conversation.pullRequestNumber
              ? `Push new commits to PR #${conversation.pullRequestNumber}? Press y to confirm or n to cancel.`
              : `Push ${conversation.branch} and open a draft PR against ${baseBranch}? Press y to confirm or n to cancel.`
          );
        } else if (name === "archive") {
          if (conversation) {
            await client.request("conversation.archive", {
              conversationId: conversation.id,
              archived: true,
            });
            await refreshConversations();
            setNotice("Conversation archived");
          } else if (project) {
            await client.request("project.archive", {
              projectId: project.id,
              archived: true,
            });
            await refreshProjects();
            setNotice("Project archived");
          }
        } else if (name === "attach") {
          if (!project || rest.length === 0) {
            throw new Error("Usage: attach /path/to/file");
          }
          const path = rest.join(" ");
          setPendingAttachments((current) => [
            ...current,
            path.startsWith("/") ? path : joinPath(project.cwd, path),
          ]);
          setNotice(`Attached ${path} to the next Turn`);
        } else if (name === "confirm") {
          if (!rest[0]) throw new Error("Usage: confirm <proposal-id>");
          await client.request("proposal.confirm", { proposalId: rest[0] });
          await refreshMessages();
          setNotice("Action proposal confirmed and completed");
        } else if (name === "reject") {
          if (!rest[0]) throw new Error("Usage: reject <proposal-id>");
          await client.request("proposal.reject", { proposalId: rest[0] });
          await refreshMessages();
          setNotice("Action proposal rejected");
        } else {
          throw new Error(
            "Commands: add <path>, new [title], attach <path>, run, cleanup, publish [base], archive, confirm <id>, reject <id>"
          );
        }
      } catch (error) {
        setNotice(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [
      client,
      conversation,
      project,
      refreshConversations,
      refreshMessages,
      refreshProjects,
      settings,
    ]
  );

  const sendMessage = useCallback(async () => {
    const text = composer.current?.plainText.trim() ?? "";
    if (!conversation || !text || busy) return;
    composer.current?.setText("");
    setBusy(true);
    setNotice("Agent turn queued…");
    try {
      const projectFileReferences = project
        ? referencedProjectFiles(project.cwd, text)
        : [];
      await client.request("conversation.send", {
        conversationId: conversation.id,
        text,
        attachmentPaths: [
          ...new Set([...pendingAttachments, ...projectFileReferences]),
        ],
      });
      setPendingAttachments([]);
      await Promise.all([refreshMessages(), refreshConversations()]);
      setNotice("Turn completed");
    } catch (error) {
      setNotice(errorMessage(error));
      await refreshMessages();
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    client,
    conversation,
    pendingAttachments,
    project,
    refreshConversations,
    refreshMessages,
  ]);

  useKeyboard((key) => {
    if (pendingAction) {
      if (key.name === "y") {
        const action = pendingAction;
        setPendingAction(undefined);
        setBusy(true);
        void (
          action.kind === "run"
            ? client
                .request<WorkflowRunResult>("workflow.run", {
                  cwd: action.project.cwd,
                })
                .then((result) => setNotice(workflowNotice(result)))
            : client
                .request("conversation.publish", {
                  conversationId: action.conversation.id,
                  baseBranch: action.baseBranch,
                  draft: true,
                })
                .then(async () => {
                  await refreshConversations();
                  setNotice(
                    action.conversation.pullRequestNumber
                      ? `Pull request #${action.conversation.pullRequestNumber} updated`
                      : "Draft pull request published"
                  );
                })
        )
          .catch((error) => setNotice(errorMessage(error)))
          .finally(() => setBusy(false));
      } else if (key.name === "n" || key.name === "escape") {
        setPendingAction(undefined);
        setNotice("Action cancelled");
      }
      return;
    }
    if (cleanupPreview) {
      if (key.name === "y") {
        setBusy(true);
        void client
          .request<CleanupResult>("cleanup.execute", {
            authorizationId: cleanupPreview.authorizationId,
            candidateIds: cleanupPreview.candidates
              .filter((candidate) => candidate.action === "remove")
              .map((candidate) => candidate.id),
          })
          .then((result) =>
            setNotice(
              `Cleanup removed ${result.removed.length}, preserved ${result.skipped.length}, failed ${result.failed.length}.`
            )
          )
          .catch((error) => setNotice(errorMessage(error)))
          .finally(() => {
            setCleanupPreview(undefined);
            setBusy(false);
          });
      } else if (key.name === "n" || key.name === "escape") {
        setCleanupPreview(undefined);
        setNotice("Cleanup cancelled");
      }
      return;
    }
    if (key.ctrl && key.name === "c") {
      renderer.destroy();
    } else if (key.name === "escape" && commandOpen) {
      setCommandOpen(false);
      setFocus("composer");
    } else if (
      focus === "conversations" &&
      (key.name === "up" || key.name === "down") &&
      conversations.length > 0
    ) {
      setConversation(
        selectAdjacentConversation(conversations, conversation?.id, key.name)
      );
    } else if (key.name === "tab" && !commandOpen) {
      const order = ["projects", "conversations", "composer"] as const;
      const index = order.indexOf(focus as (typeof order)[number]);
      setFocus(order[(index + 1) % order.length] ?? "projects");
    } else if (
      (key.ctrl && key.name === "p") ||
      (key.name === "/" && focus !== "composer")
    ) {
      setCommandOpen(true);
      setFocus("command");
    }
  });

  const projectOptions = useMemo<SelectOption[]>(
    () =>
      projects.map((item) => ({
        name: item.name,
        description: item.repository ?? item.cwd,
        value: item.id,
      })),
    [projects]
  );
  const conversationOptions = useMemo<SelectOption[]>(
    () =>
      conversations.map((item) => ({
        name: item.title,
        description: `${item.status} · ${item.profile.model}`,
        value: item.id,
      })),
    [conversations]
  );

  const narrow = width < 90;
  const medium = width < 140;
  return (
    <box
      style={{
        width,
        height,
        flexDirection: "column",
        backgroundColor: "#0b0d12",
      }}
    >
      <box
        style={{
          height: 3,
          paddingLeft: 1,
          paddingRight: 1,
          justifyContent: "space-between",
          border: true,
          borderColor: "#334155",
        }}
      >
        <text fg="#f8fafc">
          <strong>Prtisan</strong> · Projects and Conversations
        </text>
        <text fg={busy ? "#fbbf24" : "#94a3b8"}>{notice}</text>
      </box>

      <box style={{ flexGrow: 1, flexDirection: narrow ? "column" : "row" }}>
        <box
          title="Projects"
          style={{
            border: true,
            borderColor: focus === "projects" ? "#38bdf8" : "#334155",
            width: narrow ? "100%" : medium ? "25%" : "20%",
            height: narrow ? 5 : "100%",
            flexDirection: "column",
          }}
        >
          <select
            options={projectOptions}
            focused={focus === "projects"}
            showDescription={!narrow}
            onSelect={(_, option) =>
              setProject(projects.find((item) => item.id === option?.value))
            }
          />
          {!narrow && (
            <box
              title="Conversations"
              style={{ border: true, borderColor: "#334155", flexGrow: 1 }}
            >
              <select
                options={conversationOptions}
                selectedIndex={Math.max(
                  0,
                  conversations.findIndex(
                    (item) => item.id === conversation?.id
                  )
                )}
                focused={focus === "conversations"}
                onSelect={(_, option) =>
                  setConversation(
                    conversations.find((item) => item.id === option?.value)
                  )
                }
              />
            </box>
          )}
        </box>

        <box
          title={conversation?.title ?? "Conversation"}
          style={{
            border: true,
            borderColor: focus === "composer" ? "#38bdf8" : "#334155",
            flexGrow: 1,
            flexDirection: "column",
          }}
        >
          {narrow && (
            <box
              title="Conversations"
              style={{
                border: true,
                borderColor: focus === "conversations" ? "#38bdf8" : "#334155",
                height: 4,
              }}
            >
              <select
                id="narrow-conversation-select"
                style={{ flexGrow: 1 }}
                options={conversationOptions}
                selectedIndex={Math.max(
                  0,
                  conversations.findIndex(
                    (item) => item.id === conversation?.id
                  )
                )}
                focused={focus === "conversations"}
                showDescription={!narrow}
                onSelect={(_, option) =>
                  setConversation(
                    conversations.find((item) => item.id === option?.value)
                  )
                }
              />
            </box>
          )}
          <scrollbox
            style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}
            stickyScroll
            stickyStart="bottom"
          >
            {messages.length === 0 ? (
              <text fg="#64748b">
                Start a Conversation with /new, then send a prompt.
              </text>
            ) : (
              messages.map((message) => (
                <box
                  key={message.id}
                  style={{
                    flexDirection: "column",
                    marginBottom: 1,
                    border: ["left"],
                    borderColor:
                      message.role === "user" ? "#38bdf8" : "#a78bfa",
                    paddingLeft: 1,
                  }}
                >
                  <text fg={message.role === "user" ? "#7dd3fc" : "#c4b5fd"}>
                    {message.role.toUpperCase()} · {message.status}
                  </text>
                  <text fg="#e2e8f0">{message.text}</text>
                  {message.events.length > 0 && (
                    <text fg="#64748b">
                      Activity:{" "}
                      {message.events.map((event) => event.summary).join(" · ")}
                    </text>
                  )}
                </box>
              ))
            )}
          </scrollbox>
          <box
            title={conversation ? "Message" : "Select a Conversation"}
            style={{
              height: narrow ? 5 : 6,
              border: true,
              borderColor: "#475569",
            }}
          >
            <textarea
              ref={composer}
              focused={focus === "composer" && Boolean(conversation)}
              placeholder={
                conversation
                  ? "Ask Prtisan… @path attaches, Enter sends"
                  : "Use /new to create a Conversation"
              }
              onSubmit={() => void sendMessage()}
            />
          </box>
        </box>

        {!medium && (
          <box
            title="Inspector"
            style={{
              border: true,
              borderColor: "#334155",
              width: "24%",
              padding: 1,
              flexDirection: "column",
            }}
          >
            <text fg="#7dd3fc">
              <strong>{project?.name ?? "No Project"}</strong>
            </text>
            <text fg="#94a3b8">{project?.cwd ?? ""}</text>
            <text fg="#e2e8f0">
              {conversation
                ? [
                    `Status: ${conversation.status}`,
                    `Base: ${conversation.baseRef}`,
                    `Branch: ${conversation.branch}`,
                    `Model: ${conversation.profile.model}`,
                    conversation.pullRequestUrl
                      ? `PR: ${conversation.pullRequestUrl}`
                      : "PR: not published",
                  ].join("\n")
                : "Select or create a Conversation."}
            </text>
            <text fg="#94a3b8">
              {"\n"}Capabilities{"\n"}
              {capabilities
                .map(
                  (capability) =>
                    `${capability.available ? "✓" : "×"} ${capability.capability}: ${capability.details}`
                )
                .join("\n")}
            </text>
            <text fg="#64748b">
              {"\n"}Commands{"\n"}/new [title]{"\n"}/add PATH{"\n"}/run
              {"\n"}/cleanup{"\n"}/publish [base]{"\n"}/archive
              {"\n"}/attach PATH
            </text>
            {proposals.length > 0 && (
              <text fg="#fbbf24">
                {"\n"}Action proposals{"\n"}
                {proposals
                  .map((proposal) =>
                    [
                      `${proposal.id} ${proposal.status}`,
                      `${proposal.kind}: ${proposal.title}`,
                      JSON.stringify(proposal.payload),
                    ].join("\n")
                  )
                  .join("\n")}
                {"\n"}Use /confirm FULL_ID or /reject FULL_ID.
              </text>
            )}
          </box>
        )}
      </box>

      {commandOpen && (
        <box
          title="Command palette"
          style={{
            position: "absolute",
            left: Math.max(2, Math.floor(width * 0.2)),
            top: Math.max(2, Math.floor(height * 0.25)),
            width: Math.max(40, Math.floor(width * 0.6)),
            height: 5,
            border: true,
            borderColor: "#38bdf8",
            backgroundColor: "#111827",
            padding: 1,
          }}
        >
          <input
            focused
            placeholder="new, add, attach, run, cleanup, publish, archive, confirm, reject"
            onSubmit={(value) =>
              void runCommand(typeof value === "string" ? value : "")
            }
          />
        </box>
      )}

      <box
        style={{
          height: 2,
          paddingLeft: 1,
          justifyContent: "space-between",
        }}
      >
        <text fg="#64748b">
          Tab focus · Ctrl-P commands · Ctrl-C quit · mouse supported
        </text>
        <text fg="#64748b">
          {projects.length} project(s) · {conversations.length} conversation(s)
          {pendingAttachments.length > 0
            ? ` · ${pendingAttachments.length} attachment(s)`
            : ""}
        </text>
      </box>
    </box>
  );
}

function workflowNotice(result: WorkflowRunResult): string {
  if (result.kind === "train") {
    return `Run ${result.planId}: ${result.snapshot.outcome}`;
  }
  return `${result.kind}: ${result.outcome}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function selectAdjacentConversation(
  conversations: readonly Conversation[],
  selectedId: string | undefined,
  direction: "up" | "down"
): Conversation | undefined {
  if (conversations.length === 0) return undefined;
  const current = Math.max(
    0,
    conversations.findIndex((item) => item.id === selectedId)
  );
  const next =
    direction === "down"
      ? Math.min(conversations.length - 1, current + 1)
      : Math.max(0, current - 1);
  return conversations[next];
}

function referencedProjectFiles(cwd: string, text: string): string[] {
  return [...text.matchAll(/(?:^|\s)@([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g)]
    .map((match) => match[1])
    .filter((path): path is string => Boolean(path))
    .map((path) => joinPath(cwd, path));
}
