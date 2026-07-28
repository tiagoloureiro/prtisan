/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import type { Conversation } from "@/control/types.js";
import {
  PrtisanApp,
  selectAdjacentConversation,
  type TuiClient,
} from "@/tui.js";

test("renders the shell with an interactive narrow Conversation selector", async () => {
  const screen = await testRender(
    <PrtisanApp client={tuiClient()} cwd="/repo" />,
    {
      width: 80,
      height: 24,
    }
  );
  try {
    await act(async () => {
      await screen.waitForFrame((frame) => frame.includes("Conversations"));
    });
    expect(screen.captureCharFrame()).not.toContain("Inspector");
    expect(screen.captureCharFrame()).toContain("Prtisan");
    expect(screen.captureCharFrame()).toContain("Projects");
    expect(screen.captureCharFrame()).toContain("Conversations");
    expect(
      screen.renderer.root.findDescendantById("narrow-conversation-select")
    ).toBeDefined();
    expect(
      selectAdjacentConversation(
        [
          conversation("conversation-1", "First conversation"),
          conversation("conversation-2", "Second conversation"),
        ],
        "conversation-1",
        "down"
      )?.id
    ).toBe("conversation-2");
  } finally {
    await act(async () => screen.renderer.destroy());
  }
});

function tuiClient(): TuiClient {
  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (method === "project.add") {
        return {
          id: "project-1",
          cwd: "/repo",
          name: "repo",
          archived: false,
          createdAt: "2026-07-28T00:00:00.000Z",
          updatedAt: "2026-07-28T00:00:00.000Z",
        } as T;
      }
      if (method === "project.list") {
        return [
          {
            id: "project-1",
            cwd: "/repo",
            name: "repo",
            archived: false,
            createdAt: "2026-07-28T00:00:00.000Z",
            updatedAt: "2026-07-28T00:00:00.000Z",
          },
        ] as T;
      }
      if (method === "conversation.list") {
        return [
          conversation("conversation-1", "First conversation"),
          conversation("conversation-2", "Second conversation"),
        ] as T;
      }
      if (method === "conversation.messages") {
        const conversationId = (params as { conversationId?: string })
          .conversationId;
        return [
          {
            id: `message-${conversationId}`,
            conversationId,
            role: "assistant",
            text:
              conversationId === "conversation-2"
                ? "SECOND TRANSCRIPT"
                : "FIRST TRANSCRIPT",
            status: "completed",
            attachments: [],
            events: [],
            createdAt: "2026-07-28T00:00:00.000Z",
          },
        ] as T;
      }
      return [] as T;
    },
    onEvent: () => () => undefined,
  };
}

function conversation(id: string, title: string): Conversation {
  return {
    id,
    projectId: "project-1",
    title,
    baseRef: "main",
    baseSha: "a".repeat(40),
    branch: `prtisan/conversation/${id}`,
    profile: { model: "test", reasoningEffort: "medium" },
    status: "active",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}
