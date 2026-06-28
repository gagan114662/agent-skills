/**
 * iMessage room proof gate (#1283).
 *
 * A configured relay, a test send, or a dashboard badge does not prove the product promise. The close bar is
 * one correlated loop: verified member recipient -> outbound room message reaches Apple Messages -> the user
 * replies from that recipient -> the reply lands in the canonical room -> an agent response is visible there ->
 * the response/acknowledgement is delivered back through the signed Mac relay.
 */

export type IMessageRoomRequirement =
  | "verified_recipient"
  | "active_relay"
  | "room_started"
  | "outbound_room_delivery"
  | "inbound_reply_ingested"
  | "agent_response_visible"
  | "outbound_agent_reply";

export interface IMessageRoomRecipientProof {
  readonly workspaceId: string;
  readonly memberId: string;
  readonly recipient: string;
  readonly verified: boolean;
  readonly verifiedAt: string;
}

export interface IMessageRoomRelayProof {
  readonly relayId: string;
  readonly host: string;
  readonly checkedInAt: string;
  readonly activeWithinMs: number;
  readonly signedHeartbeatAccepted: boolean;
}

export interface IMessageRoomStartProof {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly receipt: string;
  readonly postedInRoom: boolean;
}

export interface IMessageRoomDeliveryProof {
  readonly jobId: string;
  readonly purpose: "room" | "notification";
  readonly status: "pending" | "claimed" | "sent" | "failed";
  readonly recipient: string;
  readonly receipt: string;
  readonly sentAt: string;
}

export interface IMessageRoomInboundReplyProof {
  readonly receipt: string;
  readonly sender: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly replyToMessageId: string;
  readonly visibleInRoom: boolean;
}

export interface IMessageRoomAgentResponseProof {
  readonly agentMessageId: string;
  readonly agentMemberId: string;
  readonly channelId: string;
  readonly respondsToMessageId: string;
  readonly postedInRoom: boolean;
}

export interface IMessageRoomProof {
  readonly recipient: IMessageRoomRecipientProof;
  readonly relay: IMessageRoomRelayProof;
  readonly roomStart: IMessageRoomStartProof;
  readonly outboundRoomDelivery: IMessageRoomDeliveryProof;
  readonly inboundReply: IMessageRoomInboundReplyProof;
  readonly agentResponse: IMessageRoomAgentResponseProof;
  readonly outboundReplyDelivery: IMessageRoomDeliveryProof;
}

export interface IMessageRoomProofGap {
  readonly requirement: IMessageRoomRequirement;
  readonly message: string;
}

export interface IMessageRoomProofResult {
  readonly proven: boolean;
  readonly gaps: readonly IMessageRoomProofGap[];
}

function push(gaps: IMessageRoomProofGap[], requirement: IMessageRoomRequirement, message: string): void {
  gaps.push({ requirement, message });
}

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function normalizeRecipient(value: string): string {
  return value.trim().toLowerCase();
}

function expectedReceipt(channelId: string, messageId: string): string {
  return "imessage:" + channelId + ":" + messageId;
}

function sameReceipt(proof: IMessageRoomProof): boolean {
  const receipt = proof.roomStart.receipt;
  return (
    nonBlank(receipt) &&
    proof.outboundRoomDelivery.receipt === receipt &&
    proof.inboundReply.receipt === receipt &&
    proof.outboundReplyDelivery.receipt === receipt
  );
}

function sentDelivery(delivery: IMessageRoomDeliveryProof): boolean {
  return nonBlank(delivery.jobId) && delivery.status === "sent" && nonBlank(delivery.sentAt);
}

export function verifyIMessageRoomProof(proof: IMessageRoomProof): IMessageRoomProofResult {
  const gaps: IMessageRoomProofGap[] = [];
  const recipient = normalizeRecipient(proof.recipient.recipient);
  const roomReceipt = expectedReceipt(proof.roomStart.channelId, proof.roomStart.messageId);

  if (
    !nonBlank(proof.recipient.workspaceId) ||
    !nonBlank(proof.recipient.memberId) ||
    !nonBlank(recipient) ||
    !proof.recipient.verified ||
    !nonBlank(proof.recipient.verifiedAt)
  ) {
    push(gaps, "verified_recipient", "A real member iMessage destination must be verified by a sent relay job.");
  }

  if (
    !nonBlank(proof.relay.relayId) ||
    !nonBlank(proof.relay.host) ||
    !nonBlank(proof.relay.checkedInAt) ||
    proof.relay.activeWithinMs <= 0 ||
    !proof.relay.signedHeartbeatAccepted
  ) {
    push(gaps, "active_relay", "A signed Mac relay heartbeat must be accepted and recently active.");
  }

  if (
    !proof.roomStart.postedInRoom ||
    proof.roomStart.workspaceId !== proof.recipient.workspaceId ||
    !nonBlank(proof.roomStart.channelId) ||
    !nonBlank(proof.roomStart.messageId) ||
    proof.roomStart.receipt !== roomReceipt
  ) {
    push(gaps, "room_started", "The user's start text must be persisted in the canonical room with its iMessage receipt.");
  }

  if (
    proof.outboundRoomDelivery.purpose !== "room" ||
    !sentDelivery(proof.outboundRoomDelivery) ||
    normalizeRecipient(proof.outboundRoomDelivery.recipient) !== recipient
  ) {
    push(gaps, "outbound_room_delivery", "The room-start message must be sent to the verified recipient by the Mac relay.");
  }
  if (!sameReceipt(proof)) {
    push(gaps, "outbound_room_delivery", "Outbound, inbound, and reply receipts must all correlate to the same room receipt.");
  }

  if (
    normalizeRecipient(proof.inboundReply.sender) !== recipient ||
    proof.inboundReply.channelId !== proof.roomStart.channelId ||
    proof.inboundReply.replyToMessageId !== proof.roomStart.messageId ||
    !nonBlank(proof.inboundReply.messageId) ||
    !proof.inboundReply.visibleInRoom
  ) {
    push(gaps, "inbound_reply_ingested", "The user's iMessage reply must be threaded into the same canonical room.");
  }

  if (
    !nonBlank(proof.agentResponse.agentMessageId) ||
    !nonBlank(proof.agentResponse.agentMemberId) ||
    proof.agentResponse.channelId !== proof.roomStart.channelId ||
    proof.agentResponse.respondsToMessageId !== proof.inboundReply.messageId ||
    !proof.agentResponse.postedInRoom
  ) {
    push(gaps, "agent_response_visible", "An agent response must be visible in the canonical room after the inbound reply.");
  }

  if (
    proof.outboundReplyDelivery.purpose !== "notification" ||
    !sentDelivery(proof.outboundReplyDelivery) ||
    normalizeRecipient(proof.outboundReplyDelivery.recipient) !== recipient
  ) {
    push(gaps, "outbound_agent_reply", "The agent response or acknowledgement must be delivered back to iMessage.");
  }

  return { proven: gaps.length === 0, gaps };
}
