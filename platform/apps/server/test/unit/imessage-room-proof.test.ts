import { describe, expect, it } from "vitest";
import {
  verifyIMessageRoomProof,
  type IMessageRoomProof,
} from "../../src/imessage/proof.js";

const baseProof: IMessageRoomProof = {
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

describe("verifyIMessageRoomProof (#1283 close gate)", () => {
  it("passes only when the full user text -> room -> agent -> iMessage reply loop is proven", () => {
    const result = verifyIMessageRoomProof(baseProof);

    expect(result.proven).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it("rejects preview/test relay claims without verified recipient, active relay, sent jobs, inbound reply, and agent response", () => {
    const result = verifyIMessageRoomProof({
      ...baseProof,
      recipient: {
        ...baseProof.recipient,
        verified: false,
        verifiedAt: "",
      },
      relay: {
        ...baseProof.relay,
        checkedInAt: "",
        signedHeartbeatAccepted: false,
      },
      roomStart: {
        ...baseProof.roomStart,
        receipt: "imessage:other:message",
        postedInRoom: false,
      },
      outboundRoomDelivery: {
        ...baseProof.outboundRoomDelivery,
        status: "failed",
        recipient: "someone@example.co",
        receipt: "imessage:other:message",
        sentAt: "",
      },
      inboundReply: {
        ...baseProof.inboundReply,
        sender: "someone@example.co",
        replyToMessageId: "other_message",
        visibleInRoom: false,
      },
      agentResponse: {
        ...baseProof.agentResponse,
        agentMessageId: "",
        postedInRoom: false,
      },
      outboundReplyDelivery: {
        ...baseProof.outboundReplyDelivery,
        status: "pending",
        sentAt: "",
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps.map((gap) => gap.requirement)).toEqual([
      "verified_recipient",
      "active_relay",
      "room_started",
      "outbound_room_delivery",
      "outbound_room_delivery",
      "inbound_reply_ingested",
      "agent_response_visible",
      "outbound_agent_reply",
    ]);
  });
});
