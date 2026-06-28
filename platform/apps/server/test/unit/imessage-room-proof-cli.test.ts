import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IMessageRoomProof } from "../../src/imessage/proof.js";
import {
  formatIMessageRoomProofReport,
  loadIMessageRoomProofJson,
  parseIMessageRoomProofCliConfig,
  type IMessageRoomProofCliConfig,
} from "../../src/imessage/proof-cli.js";

const completeProof: IMessageRoomProof = {
  recipient: {
    workspaceId: "workspace_123",
    memberId: "member_123",
    recipient: "founder@example.co",
    verified: true,
    verifiedAt: "2026-06-28T12:00:00.000Z",
  },
  relay: {
    relayId: "gagan-mac",
    host: "Gagan-MacBook-Pro",
    checkedInAt: "2026-06-28T12:05:00.000Z",
    activeWithinMs: 120_000,
    signedHeartbeatAccepted: true,
  },
  roomStart: {
    workspaceId: "workspace_123",
    channelId: "channel_123",
    messageId: "message_start_123",
    receipt: "imessage:channel_123:message_start_123",
    postedInRoom: true,
  },
  outboundRoomDelivery: {
    jobId: "job_room_123",
    purpose: "room",
    status: "sent",
    recipient: "founder@example.co",
    receipt: "imessage:channel_123:message_start_123",
    sentAt: "2026-06-28T12:06:00.000Z",
  },
  inboundReply: {
    receipt: "imessage:channel_123:message_start_123",
    sender: "founder@example.co",
    channelId: "channel_123",
    messageId: "message_inbound_123",
    replyToMessageId: "message_start_123",
    visibleInRoom: true,
  },
  agentResponse: {
    agentMessageId: "message_agent_123",
    agentMemberId: "agent_echo",
    channelId: "channel_123",
    respondsToMessageId: "message_inbound_123",
    postedInRoom: true,
  },
  outboundReplyDelivery: {
    jobId: "job_reply_123",
    purpose: "notification",
    status: "sent",
    recipient: "founder@example.co",
    receipt: "imessage:channel_123:message_start_123",
    sentAt: "2026-06-28T12:08:00.000Z",
  },
};

describe("iMessage room proof CLI (#1283)", () => {
  it("parses --file and -f", () => {
    expect(parseIMessageRoomProofCliConfig(["--file", "proof.json"])).toEqual({ file: "proof.json" });
    expect(parseIMessageRoomProofCliConfig(["-f=proof.json"])).toEqual({ file: "proof.json" });
  });

  it("loads proof JSON from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imessage-room-proof-"));
    const file = join(dir, "proof.json");
    await writeFile(file, JSON.stringify(completeProof), "utf8");

    await expect(loadIMessageRoomProofJson({ file })).resolves.toMatchObject({
      roomStart: { receipt: "imessage:channel_123:message_start_123" },
      inboundReply: { messageId: "message_inbound_123" },
    });
  });

  it("formats a passing proof report", () => {
    expect(formatIMessageRoomProofReport(completeProof)).toEqual([
      "PASS imessage-room-proof: verified recipient -> room send -> inbound reply -> agent response -> iMessage reply proven",
    ]);
  });

  it("fails closed with actionable gaps for preview-only relay claims", () => {
    const lines = formatIMessageRoomProofReport({
      ...completeProof,
      relay: { ...completeProof.relay, signedHeartbeatAccepted: false },
      outboundRoomDelivery: { ...completeProof.outboundRoomDelivery, status: "pending", sentAt: "" },
      inboundReply: { ...completeProof.inboundReply, visibleInRoom: false },
      outboundReplyDelivery: { ...completeProof.outboundReplyDelivery, status: "failed", sentAt: "" },
    });

    expect(lines[0]).toBe("FAIL imessage-room-proof: 4 gap(s)");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FAIL active_relay:"),
        expect.stringContaining("FAIL outbound_room_delivery:"),
        expect.stringContaining("FAIL inbound_reply_ingested:"),
        expect.stringContaining("FAIL outbound_agent_reply:"),
      ]),
    );
  });

  it("requires a proof JSON body", async () => {
    const readStdin = async () => "   ";
    await expect(
      loadIMessageRoomProofJson({ file: "", readStdin } as IMessageRoomProofCliConfig),
    ).rejects.toThrow("imessage-room proof JSON is required");
  });
});
