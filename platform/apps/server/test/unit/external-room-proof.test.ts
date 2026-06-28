import { describe, expect, it } from "vitest";
import type { ExternalRoomProof } from "../../src/messaging/external-room-proof.js";
import { verifyExternalRoomProof } from "../../src/messaging/external-room-proof.js";

const completeProof: ExternalRoomProof = {
  webRoom: {
    workspaceId: "workspace_123",
    channelId: "channel_123",
    roomMessageId: "message_room_123",
    canonicalUrl: "https://ipop.ai/app/workspaces/workspace_123/rooms/channel_123",
    sourceOfTruth: true,
    visibleInWeb: true,
  },
  externalDelivery: {
    provider: "telegram",
    workspaceId: "workspace_123",
    channelId: "channel_123",
    messageId: "message_room_123",
    providerConversationId: "tg-room-123",
    providerMessageId: "tg-message-456",
    status: "sent",
    sentAt: "2026-06-28T13:00:00.000Z",
    receipt: "telegram:tg-room-123:tg-message-456",
    connected: true,
  },
  inboundReply: {
    provider: "telegram",
    workspaceId: "workspace_123",
    channelId: "channel_123",
    providerConversationId: "tg-room-123",
    providerMessageId: "tg-reply-789",
    senderRef: "founder_telegram_user",
    messageId: "message_reply_123",
    replyToMessageId: "message_room_123",
    visibleInWebRoom: true,
    receivedAt: "2026-06-28T13:01:00.000Z",
  },
  approval: {
    approvalRequestId: "approval_123",
    provider: "telegram",
    command: "approve campaign launch",
    decision: "approved",
    decidedByMemberId: "member_founder",
    auditReceiptId: "audit_approval_123",
    executedByCanonicalApprovalPath: true,
    selfApproval: false,
  },
  links: {
    previewUrl: "https://ipop.ai/p/campaign-preview",
    receiptUrl: "https://ipop.ai/receipts/approval_123",
    permissionSafe: true,
  },
};

describe("external room proof gate (#1267)", () => {
  it("accepts a correlated web room, provider delivery, inbound reply, and approval audit proof", () => {
    expect(verifyExternalRoomProof(completeProof)).toEqual({ proven: true, gaps: [] });
  });

  it("requires the web room to be canonical and visible", () => {
    const result = verifyExternalRoomProof({
      ...completeProof,
      webRoom: { ...completeProof.webRoom, sourceOfTruth: false, visibleInWeb: false },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps).toEqual([expect.objectContaining({ requirement: "canonical_web_room" })]);
  });

  it("fails provider sends without connected native receipts", () => {
    const result = verifyExternalRoomProof({
      ...completeProof,
      externalDelivery: {
        ...completeProof.externalDelivery,
        connected: false,
        status: "pending",
        providerMessageId: "",
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps).toEqual([expect.objectContaining({ requirement: "external_delivery" })]);
  });

  it("requires inbound provider replies to thread back into the same web room", () => {
    const result = verifyExternalRoomProof({
      ...completeProof,
      inboundReply: {
        ...completeProof.inboundReply,
        replyToMessageId: "some-other-message",
        visibleInWebRoom: false,
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps).toEqual([expect.objectContaining({ requirement: "inbound_reply" })]);
  });

  it("rejects external approval claims that bypass the canonical approval path", () => {
    const result = verifyExternalRoomProof({
      ...completeProof,
      approval: {
        ...completeProof.approval,
        executedByCanonicalApprovalPath: false,
        selfApproval: true,
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps).toEqual([expect.objectContaining({ requirement: "approval_roundtrip" })]);
  });

  it("requires one correlated workspace, channel, message, provider, and conversation", () => {
    const result = verifyExternalRoomProof({
      ...completeProof,
      externalDelivery: { ...completeProof.externalDelivery, channelId: "channel_other" },
      inboundReply: { ...completeProof.inboundReply, provider: "whatsapp" },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps).toEqual([expect.objectContaining({ requirement: "provider_correlation" })]);
  });

  it("requires permission-safe public proof links", () => {
    const result = verifyExternalRoomProof({
      ...completeProof,
      links: { previewUrl: "file:///tmp/proof.html", receiptUrl: "not a url", permissionSafe: false },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps).toEqual([expect.objectContaining({ requirement: "permission_safe_links" })]);
  });
});
