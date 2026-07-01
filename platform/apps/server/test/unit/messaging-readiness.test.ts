import { describe, expect, it } from "vitest";
import type { ServiceCredentialRow } from "../../src/db/repositories/external-credentials.js";
import type { ExternalRoomMessageProof } from "../../src/db/repositories/external-room-message-receipts.js";
import type {
  IMessageRecipient,
  IMessageRelayHeartbeat,
  IMessageRelayInboundReceipt,
  IMessageRelayJob,
} from "../../src/db/repositories/imessage.js";
import {
  buildExternalProviderReadiness,
  buildIMessageReadiness,
  normalizeTelegramDestination,
  normalizeWhatsAppDestination,
  ROUND_TRIP_PROOF_MAX_AGE_MS,
} from "../../src/messaging/readiness.js";

const nowMs = Date.UTC(2026, 5, 29, 12);

function connection(input: Partial<ServiceCredentialRow> = {}): ServiceCredentialRow {
  return {
    serviceKey: input.serviceKey ?? "telegram_room",
    connected: input.connected ?? true,
    status: input.status ?? "connected",
    fingerprint: input.fingerprint ?? "fp",
    envKeys: input.envKeys ?? ["TELEGRAM_CHAT_ID"],
    scopes: input.scopes ?? [],
    rotationReminderDays: input.rotationReminderDays ?? 0,
    connectedAtMs: input.connectedAtMs ?? nowMs - 10_000,
    revokedAtMs: input.revokedAtMs ?? null,
  };
}

function externalProof(input: Partial<ExternalRoomMessageProof> = {}): ExternalRoomMessageProof {
  return {
    workspaceId: input.workspaceId ?? "w1",
    channelId: input.channelId ?? "c1",
    messageId: input.messageId ?? "m1",
    replyToMessageId: input.replyToMessageId,
    provider: input.provider ?? "telegram",
    providerConversationId: input.providerConversationId ?? "123456",
    providerMessageId: input.providerMessageId ?? "provider-1",
    direction: input.direction ?? "outbound",
    createdAt: input.createdAt ?? new Date(nowMs - 1_000),
  };
}

function imessageRecipient(input: Partial<IMessageRecipient> = {}): IMessageRecipient {
  return {
    id: input.id ?? "recipient-1",
    workspaceId: input.workspaceId ?? "w1",
    memberId: input.memberId ?? "member-1",
    recipient: input.recipient ?? "owner@example.com",
    serviceName: input.serviceName ?? null,
    verifiedAt: input.verifiedAt ?? new Date(nowMs - 10_000),
    createdAt: input.createdAt ?? new Date(nowMs - 20_000),
    updatedAt: input.updatedAt ?? new Date(nowMs - 10_000),
  };
}

function relayJob(input: Partial<IMessageRelayJob> = {}): IMessageRelayJob {
  return {
    id: input.id ?? "job-1",
    workspaceId: input.workspaceId ?? "w1",
    memberId: input.memberId ?? "member-1",
    channelId: input.channelId ?? "c1",
    messageId: input.messageId ?? "m1",
    purpose: input.purpose ?? "room",
    recipient: input.recipient ?? "owner@example.com",
    serviceName: input.serviceName ?? null,
    body: input.body ?? "hello",
    receipt: input.receipt ?? "imessage:c1:m1",
    status: input.status ?? "sent",
    lockedBy: input.lockedBy ?? null,
    lockedUntil: input.lockedUntil ?? null,
    sentAt: input.sentAt ?? new Date(nowMs - 2_000),
    failedAt: input.failedAt ?? null,
    error: input.error ?? null,
    createdAt: input.createdAt ?? new Date(nowMs - 3_000),
    updatedAt: input.updatedAt ?? new Date(nowMs - 2_000),
  };
}

function inboundReceipt(input: Partial<IMessageRelayInboundReceipt> = {}): IMessageRelayInboundReceipt {
  return {
    id: input.id ?? "inbound-1",
    workspaceId: input.workspaceId ?? "w1",
    memberId: input.memberId ?? "member-1",
    channelId: input.channelId ?? "c1",
    messageId: input.messageId ?? "reply-1",
    replyToMessageId: input.replyToMessageId ?? "m1",
    sender: input.sender ?? "owner@example.com",
    receipt: input.receipt ?? "imessage:c1:m1",
    text: input.text ?? "reply",
    createdAt: input.createdAt ?? new Date(nowMs - 1_000),
  };
}

function heartbeat(input: Partial<IMessageRelayHeartbeat> = {}): IMessageRelayHeartbeat {
  return {
    relayId: input.relayId ?? "relay-1",
    host: input.host ?? "mac-mini",
    version: input.version ?? "1.0.0",
    messagesAccess: input.messagesAccess ?? "ok",
    messagesDbAccess: input.messagesDbAccess ?? "ok",
    checkedInAt: input.checkedInAt ?? new Date(nowMs - 1_000),
    createdAt: input.createdAt ?? new Date(nowMs - 10_000),
    updatedAt: input.updatedAt ?? new Date(nowMs - 1_000),
  };
}

describe("messaging readiness (#1426)", () => {
  it("normalizes configured destinations without exposing provider secrets", () => {
    expect(normalizeTelegramDestination(" -1001234567890 ")).toBe("-1001234567890");
    expect(normalizeTelegramDestination("telegram-token")).toBeNull();
    expect(normalizeWhatsAppDestination("+1 (555) 111-2222")).toBe("15551112222");
    expect(normalizeWhatsAppDestination("not-a-phone")).toBeNull();
  });

  it("separates missing deployment config from workspace destination state", () => {
    const readiness = buildExternalProviderReadiness({
      provider: "telegram",
      label: "Telegram",
      configured: false,
      missingConfig: ["TELEGRAM_BOT_TOKEN"],
      connection: null,
      destination: null,
      nowMs,
    });

    expect(readiness.state).toBe("config_missing");
    expect(readiness.healthy).toBe(false);
    expect(readiness.notes).toContain("deployment config missing: TELEGRAM_BOT_TOKEN");
  });

  it("requires fresh outbound and inbound provider proof for external-room health", () => {
    const outbound = externalProof({ direction: "outbound" });
    const correlatedInbound = externalProof({
      direction: "inbound",
      messageId: "reply-1",
      providerMessageId: "provider-2",
      replyToMessageId: "m1",
    });
    const healthy = buildExternalProviderReadiness({
      provider: "telegram",
      label: "Telegram",
      configured: true,
      missingConfig: [],
      connection: connection(),
      connectedByMemberId: "member-1",
      destination: "123456",
      outboundProof: outbound,
      inboundProof: correlatedInbound,
      nowMs,
    });
    expect(healthy.state).toBe("healthy");
    expect(healthy.healthy).toBe(true);
    expect(healthy.destination.connectedByMemberId).toBe("member-1");
    expect(healthy.latestInboundProof?.replyToMessageId).toBe("m1");

    const staleOutbound = buildExternalProviderReadiness({
      provider: "telegram",
      label: "Telegram",
      configured: true,
      missingConfig: [],
      connection: connection(),
      destination: "123456",
      outboundProof: externalProof({
        direction: "outbound",
        createdAt: new Date(nowMs - ROUND_TRIP_PROOF_MAX_AGE_MS - 1),
      }),
      inboundProof: correlatedInbound,
      nowMs,
    });
    expect(staleOutbound.state).toBe("inbound_received");
    expect(staleOutbound.latestOutboundProof?.stale).toBe(true);
  });

  it("treats Telegram inbound-first chat as healthy after the team responds in the same room", () => {
    const inboundBrief = externalProof({
      direction: "inbound",
      channelId: "telegram-room",
      messageId: "owner-brief",
      providerMessageId: "tg-inbound-1",
      createdAt: new Date(nowMs - 2_000),
    });
    const teamResponse = externalProof({
      direction: "outbound",
      channelId: "telegram-room",
      messageId: "team-response",
      providerMessageId: "tg-outbound-1",
      createdAt: new Date(nowMs - 1_000),
    });

    const readiness = buildExternalProviderReadiness({
      provider: "telegram",
      label: "Telegram",
      configured: true,
      missingConfig: [],
      connection: connection(),
      destination: "123456",
      outboundProof: teamResponse,
      inboundProof: inboundBrief,
      nowMs,
    });

    expect(readiness.state).toBe("healthy");
    expect(readiness.healthy).toBe(true);
    expect(readiness.latestInboundProof?.messageId).toBe("owner-brief");
    expect(readiness.latestOutboundProof?.messageId).toBe("team-response");
    expect(readiness.notes).not.toContain(
      "latest Telegram inbound proof has not yet received a newer team response in the same room",
    );
  });

  it("keeps Telegram waiting when the latest inbound brief has no newer team response yet", () => {
    const previousResponse = externalProof({
      direction: "outbound",
      channelId: "telegram-room",
      messageId: "previous-team-response",
      providerMessageId: "tg-outbound-old",
      createdAt: new Date(nowMs - 2_000),
    });
    const latestInboundBrief = externalProof({
      direction: "inbound",
      channelId: "telegram-room",
      messageId: "new-owner-brief",
      providerMessageId: "tg-inbound-new",
      createdAt: new Date(nowMs - 1_000),
    });

    const readiness = buildExternalProviderReadiness({
      provider: "telegram",
      label: "Telegram",
      configured: true,
      missingConfig: [],
      connection: connection(),
      destination: "123456",
      outboundProof: previousResponse,
      inboundProof: latestInboundBrief,
      nowMs,
    });

    expect(readiness.state).toBe("outbound_sent");
    expect(readiness.healthy).toBe(false);
    expect(readiness.notes).toContain(
      "latest Telegram inbound proof has not yet received a newer team response in the same room",
    );
  });

  it("does not mark external-room readiness healthy from unthreaded inbound proof", () => {
    const readiness = buildExternalProviderReadiness({
      provider: "whatsapp",
      label: "WhatsApp",
      configured: true,
      missingConfig: [],
      connection: connection({ serviceKey: "whatsapp_room" }),
      destination: "15551112222",
      outboundProof: externalProof({
        provider: "whatsapp",
        providerConversationId: "15551112222",
        providerMessageId: "wamid.outbound",
        messageId: "room-message-1",
      }),
      inboundProof: externalProof({
        provider: "whatsapp",
        providerConversationId: "15551112222",
        providerMessageId: "wamid.inbound",
        direction: "inbound",
        messageId: "reply-message-1",
        replyToMessageId: "different-room-message",
      }),
      nowMs,
    });

    expect(readiness.state).toBe("outbound_sent");
    expect(readiness.healthy).toBe(false);
    expect(readiness.latestInboundProof?.replyToMessageId).toBe("different-room-message");
    expect(readiness.notes).toContain(
      "latest inbound proof is not threaded to the latest outbound room message",
    );
  });

  it("requires iMessage relay config, fresh proof, and active heartbeat", () => {
    const healthy = buildIMessageReadiness({
      status: {
        enabled: true,
        configured: true,
        dryRun: false,
        recipient: "owner@example.com",
        recipientSource: "member_verified",
        maxChars: 1000,
      },
      recipient: imessageRecipient(),
      latestSentJob: relayJob(),
      latestInboundReceipt: inboundReceipt(),
      relayHeartbeat: heartbeat(),
      nowMs,
    });
    expect(healthy.state).toBe("healthy");
    expect(healthy.healthy).toBe(true);
    expect(healthy.missingConfig).toEqual([]);

    const staleHeartbeat = buildIMessageReadiness({
      status: {
        enabled: true,
        configured: true,
        dryRun: false,
        recipient: "owner@example.com",
        recipientSource: "member_verified",
        maxChars: 1000,
      },
      recipient: imessageRecipient(),
      latestSentJob: relayJob(),
      latestInboundReceipt: inboundReceipt(),
      relayHeartbeat: heartbeat({ checkedInAt: new Date(nowMs - 121_000) }),
      nowMs,
    });
    expect(staleHeartbeat.state).toBe("configured_unproven");
    expect(staleHeartbeat.healthy).toBe(false);
    expect(staleHeartbeat.missingConfig).toContain("active_iMessage_relay");
    expect(staleHeartbeat.notes).toContain("signed Mac relay heartbeat is not active");

    const messagesBlocked = buildIMessageReadiness({
      status: {
        enabled: true,
        configured: true,
        dryRun: false,
        recipient: "owner@example.com",
        recipientSource: "member_verified",
        maxChars: 1000,
      },
      recipient: imessageRecipient(),
      latestSentJob: relayJob(),
      latestInboundReceipt: inboundReceipt(),
      relayHeartbeat: { ...heartbeat(), messagesAccess: "failed" } as IMessageRelayHeartbeat,
      nowMs,
    });
    expect(messagesBlocked.state).toBe("configured_unproven");
    expect(messagesBlocked.healthy).toBe(false);
    expect(messagesBlocked.missingConfig).toContain("iMessage_messages_access");
    expect(messagesBlocked.relayHeartbeat?.messagesAccess).toBe("failed");
    expect(messagesBlocked.notes).toContain("signed Mac relay cannot control Messages; grant Messages Automation and keep Messages open");

    const dbBlocked = buildIMessageReadiness({
      status: {
        enabled: true,
        configured: true,
        dryRun: false,
        recipient: "owner@example.com",
        recipientSource: "member_verified",
        maxChars: 1000,
      },
      recipient: imessageRecipient(),
      latestSentJob: relayJob(),
      latestInboundReceipt: inboundReceipt(),
      relayHeartbeat: { ...heartbeat(), messagesDbAccess: "failed" } as IMessageRelayHeartbeat,
      nowMs,
    });
    expect(dbBlocked.state).toBe("configured_unproven");
    expect(dbBlocked.healthy).toBe(false);
    expect(dbBlocked.missingConfig).toContain("iMessage_messages_db_access");
    expect(dbBlocked.relayHeartbeat?.messagesDbAccess).toBe("failed");
    expect(dbBlocked.notes).toContain(
      "signed Mac relay cannot read Messages replies; grant Full Disk Access or set IMESSAGE_MESSAGES_DB_PATH",
    );
  });

  it("reports each iMessage operational gate in missingConfig", () => {
    const disabled = buildIMessageReadiness({
      status: {
        enabled: false,
        configured: true,
        dryRun: false,
        recipient: "owner@example.com",
        recipientSource: "member_verified",
        maxChars: 1000,
      },
      recipient: imessageRecipient(),
      relayHeartbeat: heartbeat(),
      nowMs,
    });
    expect(disabled.state).toBe("disabled");
    expect(disabled.missingConfig).toContain("iMessage_relay_enabled");

    const dryRun = buildIMessageReadiness({
      status: {
        enabled: true,
        configured: true,
        dryRun: true,
        recipient: "owner@example.com",
        recipientSource: "member_verified",
        maxChars: 1000,
      },
      recipient: imessageRecipient(),
      relayHeartbeat: heartbeat(),
      nowMs,
    });
    expect(dryRun.state).toBe("disabled");
    expect(dryRun.missingConfig).toContain("iMessage_relay_live_mode");

    const pendingRecipient = buildIMessageReadiness({
      status: {
        enabled: true,
        configured: false,
        dryRun: false,
        recipient: "owner@example.com",
        recipientSource: "member_pending",
        requiresVerification: true,
        maxChars: 1000,
      },
      recipient: imessageRecipient({ verifiedAt: null }),
      nowMs,
    });
    expect(pendingRecipient.state).toBe("config_missing");
    expect(pendingRecipient.missingConfig).toEqual(
      expect.arrayContaining(["verified_iMessage_recipient", "active_iMessage_relay"]),
    );
  });

  it("does not mark iMessage healthy from an inbound reply to an older outbound message", () => {
    const readiness = buildIMessageReadiness({
      status: {
        enabled: true,
        configured: true,
        dryRun: false,
        recipient: "owner@example.com",
        recipientSource: "member_verified",
        maxChars: 1000,
      },
      recipient: imessageRecipient(),
      latestSentJob: relayJob({ messageId: "latest-agent-update" }),
      latestInboundReceipt: inboundReceipt({ replyToMessageId: "older-room-start" }),
      relayHeartbeat: heartbeat(),
      nowMs,
    });

    expect(readiness.state).toBe("outbound_sent");
    expect(readiness.healthy).toBe(false);
    expect(readiness.latestInboundProof?.replyToMessageId).toBe("older-room-start");
    expect(readiness.notes).toContain(
      "latest iMessage inbound proof is not threaded to the latest outbound room message",
    );
  });
});
