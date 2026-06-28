import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExternalRoomProof } from "../../src/messaging/external-room-proof.js";
import {
  formatExternalRoomProofReport,
  loadExternalRoomProofJson,
  parseExternalRoomProofCliConfig,
  type ExternalRoomProofCliConfig,
} from "../../src/messaging/external-room-proof-cli.js";

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
    provider: "whatsapp",
    workspaceId: "workspace_123",
    channelId: "channel_123",
    messageId: "message_room_123",
    providerConversationId: "15551112222",
    providerMessageId: "wamid.123",
    status: "delivered",
    sentAt: "2026-06-28T13:00:00.000Z",
    receipt: "whatsapp:15551112222:wamid.123",
    connected: true,
  },
  inboundReply: {
    provider: "whatsapp",
    workspaceId: "workspace_123",
    channelId: "channel_123",
    providerConversationId: "15551112222",
    providerMessageId: "wamid.reply.123",
    senderRef: "15550001111",
    messageId: "message_reply_123",
    replyToMessageId: "message_room_123",
    visibleInWebRoom: true,
    receivedAt: "2026-06-28T13:01:00.000Z",
  },
  approval: {
    approvalRequestId: "approval_123",
    provider: "whatsapp",
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

describe("external room proof CLI (#1267)", () => {
  it("parses --file and -f", () => {
    expect(parseExternalRoomProofCliConfig(["--file", "proof.json"])).toEqual({ file: "proof.json" });
    expect(parseExternalRoomProofCliConfig(["-f=proof.json"])).toEqual({ file: "proof.json" });
  });

  it("loads proof JSON from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "external-room-proof-"));
    const file = join(dir, "proof.json");
    await writeFile(file, JSON.stringify(completeProof), "utf8");

    await expect(loadExternalRoomProofJson({ file })).resolves.toMatchObject({
      externalDelivery: { providerMessageId: "wamid.123" },
      inboundReply: { messageId: "message_reply_123" },
    });
  });

  it("formats a passing proof report", () => {
    expect(formatExternalRoomProofReport(completeProof)).toEqual([
      "PASS external-room-proof: web room -> external delivery -> inbound reply -> approval audit proven",
    ]);
  });

  it("fails closed with actionable gaps for preview-only channel claims", () => {
    const lines = formatExternalRoomProofReport({
      ...completeProof,
      webRoom: { ...completeProof.webRoom, visibleInWeb: false },
      externalDelivery: { ...completeProof.externalDelivery, status: "pending", connected: false },
      inboundReply: { ...completeProof.inboundReply, visibleInWebRoom: false },
      approval: { ...completeProof.approval, executedByCanonicalApprovalPath: false },
      links: { ...completeProof.links, permissionSafe: false },
    });

    expect(lines[0]).toBe("FAIL external-room-proof: 5 gap(s)");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FAIL canonical_web_room:"),
        expect.stringContaining("FAIL external_delivery:"),
        expect.stringContaining("FAIL inbound_reply:"),
        expect.stringContaining("FAIL approval_roundtrip:"),
        expect.stringContaining("FAIL permission_safe_links:"),
      ]),
    );
  });

  it("requires a proof JSON body", async () => {
    const readStdin = async () => "   ";
    await expect(
      loadExternalRoomProofJson({ file: "", readStdin } as ExternalRoomProofCliConfig),
    ).rejects.toThrow("external-room proof JSON is required");
  });
});
