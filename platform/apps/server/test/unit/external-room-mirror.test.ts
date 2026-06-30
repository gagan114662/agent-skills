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
      shouldMirrorExternalRoomEvent({ body: "Drafting a tighter launch angle", source: "agent_post" }),
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
        message: message(),
        source: "agent_post",
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ provider: "telegram", retryable: true }), expect.any(String));
    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ provider: "whatsapp" }));
  });
});
