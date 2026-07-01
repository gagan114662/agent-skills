import { describe, expect, it, vi } from "vitest";
import {
  classifyExternalRoomEvent,
  createExternalRoomMirror,
  formatExternalRoomEvent,
  isExternalRoomDebugChatter,
  shouldMirrorExternalRoomEvent,
} from "../../src/messaging/external-room-mirror.js";
import type { ExternalRoomMessageReceipt } from "../../src/db/repositories/external-room-message-receipts.js";
import type { Message } from "../../src/db/repositories/messages.js";
import { encodeTeamEvent } from "../../src/team/protocol.js";

function message(input: Partial<Message> = {}): Message {
  return {
    id: input.id ?? "m1",
    channelId: input.channelId ?? "c1",
    authorMemberId: input.authorMemberId ?? "agent-1",
    parentMessageId: input.parentMessageId ?? null,
    alsoSentToChannel: input.alsoSentToChannel ?? false,
    body: input.body ?? "working on the launch",
  };
}

function receipt(input: Partial<ExternalRoomMessageReceipt> = {}): ExternalRoomMessageReceipt {
  return {
    workspaceId: input.workspaceId ?? "w1",
    channelId: input.channelId ?? "c1",
    messageId: input.messageId ?? "m1",
    provider: input.provider ?? "telegram",
    providerConversationId: input.providerConversationId ?? "123456",
    providerMessageId: input.providerMessageId ?? "provider-1",
  };
}

describe("external room mirror (#1424)", () => {
  it("maps canonical room activity into external room event types", () => {
    const blockedTeamEvent = encodeTeamEvent({
      teamRunId: "tr1",
      subtaskId: "s1",
      agentMemberId: "a1",
      kind: "blocked",
      summary: "Codex auth is missing",
      branch: null,
      createdAt: new Date(0).toISOString(),
    });
    const handoffTeamEvent = encodeTeamEvent({
      teamRunId: "tr1",
      subtaskId: "s2",
      agentMemberId: "a2",
      kind: "needs_handoff",
      summary: "Echo needs Bid",
      branch: "launch-bid",
      createdAt: new Date(0).toISOString(),
    });

    expect(classifyExternalRoomEvent({ body: "hello", source: "room_message" })).toBe("room_message");
    expect(classifyExternalRoomEvent({ body: "reply here", source: "thread_reply" })).toBe("thread_reply");
    expect(classifyExternalRoomEvent({ body: blockedTeamEvent, source: "agent_post" })).toBe("blocked");
    expect(classifyExternalRoomEvent({ body: handoffTeamEvent, source: "agent_post" })).toBe("handoff");
    expect(classifyExternalRoomEvent({ body: "approval request: send campaign", source: "agent_post" })).toBe(
      "approval_request",
    );
    expect(classifyExternalRoomEvent({ body: "deliverable preview ready", source: "agent_post" })).toBe(
      "deliverable_preview",
    );
    expect(formatExternalRoomEvent({ body: blockedTeamEvent, source: "agent_post" }).text).toContain(
      "blocked: Codex auth is missing",
    );
    expect(formatExternalRoomEvent({ body: handoffTeamEvent, source: "agent_post" }).text).not.toContain(
      "team run:",
    );
    expect(
      isExternalRoomDebugChatter({
        body: "\u{1f527} /bin/sh -lc 'find . -maxdepth 3 -type f -print'",
        source: "agent_post",
      }),
    ).toBe(true);
    expect(
      shouldMirrorExternalRoomEvent({
        body: encodeTeamEvent({
          teamRunId: "tr1",
          subtaskId: "s3",
          agentMemberId: "a3",
          kind: "started",
          summary: "started: Scout site and market audit",
          branch: "messaging-scout",
          createdAt: new Date(0).toISOString(),
        }),
        source: "agent_post",
      }),
    ).toBe(false);
    expect(
      shouldMirrorExternalRoomEvent({ body: "Drafting a tighter launch angle", source: "agent_post" }),
    ).toBe(false);
    expect(
      shouldMirrorExternalRoomEvent({
        body: "deliverable preview: here are three sharper launch angles",
        source: "agent_post",
      }),
    ).toBe(true);
  });

  it("mirrors a canonical agent post to connected Telegram and WhatsApp rooms and stores receipts", async () => {
    const telegramSend = vi.fn(async () => ({
      status: "sent" as const,
      chatId: "123456",
      providerMessageId: "tg-1",
    }));
    const whatsappSend = vi.fn(async () => ({
      status: "sent" as const,
      recipient: "15551112222",
      providerMessageId: "wa-1",
    }));
    const recordReceipt = vi.fn(async () => undefined);
    const mirror = createExternalRoomMirror({
      telegram: { send: telegramSend },
      whatsapp: { send: whatsappSend },
      resolveSecrets: vi.fn(async (_workspaceId, serviceKey) =>
        serviceKey === "telegram_room"
          ? { TELEGRAM_CHAT_ID: "123456" }
          : { WHATSAPP_RECIPIENT: "+1 (555) 111-2222" },
      ),
      getReceiptForMessage: vi.fn(async () => undefined),
      recordReceipt,
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Scout" })),
    });

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ body: "Found the homepage gap" }),
      source: "agent_post",
    });

    expect(telegramSend).toHaveBeenCalledWith({
      chatId: "123456",
      text: expect.stringContaining("ref: tg:c1:m1"),
    });
    expect(telegramSend.mock.calls[0]?.[0].text).toContain("Scout: Found the homepage gap");
    expect(telegramSend.mock.calls[0]?.[0].text).not.toContain("workspace:");
    expect(whatsappSend).toHaveBeenCalledWith({
      recipient: "15551112222",
      text: expect.stringContaining("ref: wa:c1:m1"),
    });
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "telegram",
        providerConversationId: "123456",
        providerMessageId: "tg-1",
      }),
    );
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "whatsapp",
        providerConversationId: "15551112222",
        providerMessageId: "wa-1",
      }),
    );
  });

  it("does not mirror raw tool-command chatter into external rooms by default (#1496)", async () => {
    const telegramSend = vi.fn(async () => ({
      status: "sent" as const,
      chatId: "123456",
      providerMessageId: "tg-1",
    }));
    const whatsappSend = vi.fn(async () => ({
      status: "sent" as const,
      recipient: "15551112222",
      providerMessageId: "wa-1",
    }));
    const recordReceipt = vi.fn(async () => undefined);
    const mirror = createExternalRoomMirror({
      telegram: { send: telegramSend },
      whatsapp: { send: whatsappSend },
      resolveSecrets: vi.fn(async (_workspaceId, serviceKey) =>
        serviceKey === "telegram_room"
          ? { TELEGRAM_CHAT_ID: "123456" }
          : { WHATSAPP_RECIPIENT: "+1 (555) 111-2222" },
      ),
      getReceiptForMessage: vi.fn(async () => undefined),
      recordReceipt,
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Quill" })),
    });

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ body: "\u{1f527} /bin/sh -lc 'find . -maxdepth 3 -type f -print'" }),
      source: "agent_post",
    });

    expect(telegramSend).not.toHaveBeenCalled();
    expect(whatsappSend).not.toHaveBeenCalled();
    expect(recordReceipt).not.toHaveBeenCalled();
  });

  it("keeps Telegram rooms free of low-value agent preamble from live runs", async () => {
    const telegramSend = vi.fn(async () => ({
      status: "sent" as const,
      chatId: "123456",
      providerMessageId: "tg-1",
    }));
    const mirror = createExternalRoomMirror({
      telegram: { send: telegramSend },
      whatsapp: { send: vi.fn() },
      resolveSecrets: vi.fn(async (_workspaceId, serviceKey) =>
        serviceKey === "telegram_room" ? { TELEGRAM_CHAT_ID: "123456" } : {},
      ),
      getReceiptForMessage: vi.fn(async () => undefined),
      recordReceipt: vi.fn(async () => undefined),
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Scout" })),
    });

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        id: "planning",
        body:
          "I'll handle Scout's lane: verify the current ipop.ai surface, identify the positioning gap, and leave a concise receipt the rest of the room can use.",
      }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        id: "empty-workspace",
        body:
          "I found an empty workspace, so I'll leave the receipt as a new local note. The current homepage copy is very broad.",
      }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        id: "preview",
        body: "preview: Top positioning gap: ipop must lead with a marketing team in your messages, not another dashboard.",
      }),
      source: "agent_post",
    });

    expect(telegramSend).toHaveBeenCalledTimes(1);
    expect(telegramSend.mock.calls[0]?.[0].text).toContain("Scout: preview: Top positioning gap");
    expect(telegramSend.mock.calls[0]?.[0].text).not.toMatch(/empty workspace|local note|handle Scout's lane/);
  });

  it("does not mirror performative agent banter from the public homepage QA path", async () => {
    const telegramSend = vi.fn(async () => ({
      status: "sent" as const,
      chatId: "123456",
      providerMessageId: "tg-1",
    }));
    const mirror = createExternalRoomMirror({
      telegram: { send: telegramSend },
      whatsapp: { send: vi.fn() },
      resolveSecrets: vi.fn(async (_workspaceId, serviceKey) =>
        serviceKey === "telegram_room" ? { TELEGRAM_CHAT_ID: "123456" } : {},
      ),
      getReceiptForMessage: vi.fn(async () => undefined),
      recordReceipt: vi.fn(async () => undefined),
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Quill" })),
    });

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ id: "scout-1", body: "right, i read the whole thing. found something." }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ id: "quill-1", body: "i'll write the words. the good ones." }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ id: "echo-1", body: "and i'll make it loud. tastefully loud." }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        id: "preview",
        body: "deliverable preview: Lead with a Telegram room where your marketing team ships ads, posts, and tests.",
      }),
      source: "agent_post",
    });

    expect(telegramSend).toHaveBeenCalledTimes(1);
    expect(telegramSend.mock.calls[0]?.[0].text).toContain("deliverable preview: Lead with a Telegram room");
  });

  it("keeps Telegram rooms free of runtime receipts and local artifact paths", async () => {
    const telegramSend = vi.fn(async () => ({
      status: "sent" as const,
      chatId: "123456",
      providerMessageId: "tg-1",
    }));
    const mirror = createExternalRoomMirror({
      telegram: { send: telegramSend },
      whatsapp: { send: vi.fn() },
      resolveSecrets: vi.fn(async (_workspaceId, serviceKey) =>
        serviceKey === "telegram_room" ? { TELEGRAM_CHAT_ID: "123456" } : {},
      ),
      getReceiptForMessage: vi.fn(async () => undefined),
      recordReceipt: vi.fn(async () => undefined),
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Scout" })),
    });

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ id: "session-complete", body: "✅ session completed (exit 0)" }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        id: "tool-note",
        body:
          "`curl` is not installed in this container, so I’m using the browser-backed checks I already ran.",
      }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        id: "session-start",
        body: [
          "🤖 session 019f1b57-330a-7340-a8c9-1cbe3a16de62 started: You are Scout in ipop's live marketing room.",
          "",
          "The owner started this from a messaging channel.",
          "",
          "Owner brief: no internal logs.",
        ].join("\n"),
      }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        id: "shell-snapshot-error",
        body:
          "2026-07-01T01:42:14.462484Z ERROR codex_core::shell_snapshot: Shell snapshot validation failed: /home/reload/.codex/shell_snapshots/tmp: Syntax error",
      }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ id: "stdin", body: "Reading additional input from stdin..." }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        id: "skills-install-error",
        body:
          "2026-07-01T01:42:09.028272Z ERROR codex_core_skills::service: failed to install system skills: Directory not empty",
      }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        id: "launch-plan",
        body: [
          "Receipt left: [scout-launch-receipt.md](/home/reload/agent-workspaces/run/scout-launch-receipt.md)",
          "",
          "Best 3-step launch plan:",
          "",
          "1. Run a Telegram-first proof sprint.",
          "2. Turn QA into proof.",
          "3. Convert proof into one offer.",
        ].join("\n"),
      }),
      source: "agent_post",
    });

    expect(telegramSend).toHaveBeenCalledTimes(1);
    const mirrored = telegramSend.mock.calls[0]?.[0].text ?? "";
    expect(mirrored).toContain("Scout: Best 3-step launch plan:");
    expect(mirrored).toContain("1. Run a Telegram-first proof sprint.");
    expect(mirrored).not.toMatch(
      /session completed|session .*started|shell snapshot|stdin|system skills|curl|browser-backed|Receipt left|\/home\/reload/,
    );
  });

  it("deduplicates identical Telegram mirror bursts in the same room", async () => {
    const telegramSend = vi.fn(async () => ({
      status: "sent" as const,
      chatId: "123456",
      providerMessageId: "tg-1",
    }));
    const recordReceipt = vi.fn(async () => undefined);
    const mirror = createExternalRoomMirror({
      telegram: { send: telegramSend },
      whatsapp: { send: vi.fn() },
      resolveSecrets: vi.fn(async (_workspaceId, serviceKey) =>
        serviceKey === "telegram_room" ? { TELEGRAM_CHAT_ID: "123456" } : {},
      ),
      getReceiptForMessage: vi.fn(async () => undefined),
      recordReceipt,
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Quill" })),
    });

    const body = "Best 3-step launch plan:\n\n1. Run the proof sprint.\n2. Package the proof.\n3. Sell the offer.";
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ id: "deliverable-1", body }),
      source: "agent_post",
    });
    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ id: "deliverable-2", body }),
      source: "agent_post",
    });

    expect(telegramSend).toHaveBeenCalledTimes(1);
    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(telegramSend.mock.calls[0]?.[0].text).toContain("Quill: Best 3-step launch plan:");
  });

  it("summarizes plain shell transcripts before mirroring customer rooms (#1496)", async () => {
    const telegramSend = vi.fn(async () => ({
      status: "sent" as const,
      chatId: "123456",
      providerMessageId: "tg-1",
    }));
    const mirror = createExternalRoomMirror({
      telegram: { send: telegramSend },
      whatsapp: { send: vi.fn() },
      resolveSecrets: vi.fn(async (_workspaceId, serviceKey) =>
        serviceKey === "telegram_room" ? { TELEGRAM_CHAT_ID: "123456" } : {},
      ),
      getReceiptForMessage: vi.fn(async () => undefined),
      recordReceipt: vi.fn(async () => undefined),
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Quill" })),
    });

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({
        body: [
          "$ pnpm --filter @reload/web test",
          "Script completed",
          "Wall time 12.4 seconds",
          "Output:",
          "gh issue comment 1496 --body debug",
        ].join("\n"),
      }),
      source: "agent_post",
    });

    const mirrored = telegramSend.mock.calls[0]?.[0].text ?? "";
    expect(mirrored).toContain("Quill: working update: technical work is underway");
    expect(mirrored).toContain("ref: tg:c1:m1");
    expect(mirrored).not.toMatch(/pnpm|gh issue|Script completed|Wall time|Output:/);
  });

  it("skips already externally visible messages and already mirrored provider destinations", async () => {
    const telegramSend = vi.fn(async () => ({
      status: "sent" as const,
      chatId: "123456",
      providerMessageId: "tg-1",
    }));
    const whatsappSend = vi.fn(async () => ({
      status: "sent" as const,
      recipient: "15551112222",
      providerMessageId: "wa-1",
    }));
    const mirror = createExternalRoomMirror({
      telegram: { send: telegramSend },
      whatsapp: { send: whatsappSend },
      resolveSecrets: vi.fn(async (_workspaceId, serviceKey) =>
        serviceKey === "telegram_room"
          ? { TELEGRAM_CHAT_ID: "123456" }
          : { WHATSAPP_RECIPIENT: "15551112222" },
      ),
      getReceiptForMessage: vi.fn(async (input) =>
        input.provider === "telegram" ? receipt({ provider: "telegram" }) : undefined,
      ),
      recordReceipt: vi.fn(async () => undefined),
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Scout" })),
    });

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ id: "already-sent", alsoSentToChannel: true }),
      source: "room_message",
    });
    expect(telegramSend).not.toHaveBeenCalled();
    expect(whatsappSend).not.toHaveBeenCalled();

    await mirror.mirror({
      workspaceId: "w1",
      channelId: "c1",
      message: message({ id: "m1" }),
      source: "room_message",
    });
    expect(telegramSend).not.toHaveBeenCalled();
    expect(whatsappSend).toHaveBeenCalledTimes(1);
  });

  it("keeps the canonical write non-fatal when one provider send fails", async () => {
    const warn = vi.fn();
    const recordReceipt = vi.fn(async () => undefined);
    const mirror = createExternalRoomMirror({
      telegram: {
        send: vi.fn(async () => ({ status: "failed" as const, error: "Telegram unavailable" })),
      },
      whatsapp: {
        send: vi.fn(async () => ({
          status: "sent" as const,
          recipient: "15551112222",
          providerMessageId: "wa-1",
        })),
      },
      log: { warn, error: vi.fn() },
      resolveSecrets: vi.fn(async (_workspaceId, serviceKey) =>
        serviceKey === "telegram_room"
          ? { TELEGRAM_CHAT_ID: "123456" }
          : { WHATSAPP_RECIPIENT: "15551112222" },
      ),
      getReceiptForMessage: vi.fn(async () => undefined),
      recordReceipt,
      getMember: vi.fn(async () => ({ id: "agent-1", kind: "agent", displayName: "Scout" })),
    });

    await expect(
      mirror.mirror({
        workspaceId: "w1",
        channelId: "c1",
        message: message({ body: "deliverable preview: launch copy is ready after Telegram failure" }),
        source: "agent_post",
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ provider: "telegram", retryable: true }), expect.any(String));
    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ provider: "whatsapp" }));
  });
});
