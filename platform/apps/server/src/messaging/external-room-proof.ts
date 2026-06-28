/**
 * External agent-room visibility proof gate (#1267).
 *
 * The bridge doctor proves provider configuration and smoke-send reachability. This verifier proves the
 * user-visible product claim from a correlated artifact: the canonical web room received the event, an external
 * provider got the same event, the user's provider reply threaded back into that room, and an approval decision
 * resolved through the canonical approval path.
 */

export type ExternalRoomProvider = "telegram" | "whatsapp" | "imessage";

export type ExternalRoomProofRequirement =
  | "canonical_web_room"
  | "external_delivery"
  | "inbound_reply"
  | "approval_roundtrip"
  | "provider_correlation"
  | "permission_safe_links";

export interface ExternalRoomWebRoomProof {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly roomMessageId: string;
  readonly canonicalUrl: string;
  readonly sourceOfTruth: boolean;
  readonly visibleInWeb: boolean;
}

export interface ExternalRoomDeliveryProof {
  readonly provider: ExternalRoomProvider;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly providerConversationId: string;
  readonly providerMessageId: string;
  readonly status: "sent" | "delivered" | "failed" | "pending";
  readonly sentAt: string;
  readonly receipt: string;
  readonly connected: boolean;
}

export interface ExternalRoomInboundReplyProof {
  readonly provider: ExternalRoomProvider;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly providerConversationId: string;
  readonly providerMessageId: string;
  readonly senderRef: string;
  readonly messageId: string;
  readonly replyToMessageId: string;
  readonly visibleInWebRoom: boolean;
  readonly receivedAt: string;
}

export interface ExternalRoomApprovalProof {
  readonly approvalRequestId: string;
  readonly provider: ExternalRoomProvider;
  readonly command: string;
  readonly decision: "approved" | "rejected";
  readonly decidedByMemberId: string;
  readonly auditReceiptId: string;
  readonly executedByCanonicalApprovalPath: boolean;
  readonly selfApproval: boolean;
}

export interface ExternalRoomLinkProof {
  readonly previewUrl?: string;
  readonly receiptUrl?: string;
  readonly permissionSafe: boolean;
}

export interface ExternalRoomProof {
  readonly webRoom: ExternalRoomWebRoomProof;
  readonly externalDelivery: ExternalRoomDeliveryProof;
  readonly inboundReply: ExternalRoomInboundReplyProof;
  readonly approval: ExternalRoomApprovalProof;
  readonly links: ExternalRoomLinkProof;
}

export interface ExternalRoomProofGap {
  readonly requirement: ExternalRoomProofRequirement;
  readonly message: string;
}

export interface ExternalRoomProofResult {
  readonly proven: boolean;
  readonly gaps: readonly ExternalRoomProofGap[];
}

function push(
  gaps: ExternalRoomProofGap[],
  requirement: ExternalRoomProofRequirement,
  message: string,
): void {
  gaps.push({ requirement, message });
}

function nonBlank(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isPublicUrl(value: string | undefined): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function sameRoom(proof: ExternalRoomProof): boolean {
  return (
    proof.externalDelivery.workspaceId === proof.webRoom.workspaceId &&
    proof.inboundReply.workspaceId === proof.webRoom.workspaceId &&
    proof.externalDelivery.channelId === proof.webRoom.channelId &&
    proof.inboundReply.channelId === proof.webRoom.channelId
  );
}

function sameProviderThread(proof: ExternalRoomProof): boolean {
  return (
    proof.externalDelivery.provider === proof.inboundReply.provider &&
    proof.externalDelivery.provider === proof.approval.provider &&
    proof.externalDelivery.providerConversationId === proof.inboundReply.providerConversationId
  );
}

export function verifyExternalRoomProof(proof: ExternalRoomProof): ExternalRoomProofResult {
  const gaps: ExternalRoomProofGap[] = [];

  if (
    !proof.webRoom.sourceOfTruth ||
    !proof.webRoom.visibleInWeb ||
    !nonBlank(proof.webRoom.workspaceId) ||
    !nonBlank(proof.webRoom.channelId) ||
    !nonBlank(proof.webRoom.roomMessageId) ||
    !isPublicUrl(proof.webRoom.canonicalUrl)
  ) {
    push(
      gaps,
      "canonical_web_room",
      "The canonical web room must be visible, source-of-truth, and linked by a valid URL.",
    );
  }

  if (
    !proof.externalDelivery.connected ||
    !["sent", "delivered"].includes(proof.externalDelivery.status) ||
    !nonBlank(proof.externalDelivery.providerConversationId) ||
    !nonBlank(proof.externalDelivery.providerMessageId) ||
    !nonBlank(proof.externalDelivery.sentAt) ||
    !nonBlank(proof.externalDelivery.receipt)
  ) {
    push(
      gaps,
      "external_delivery",
      "A connected provider must send the room event and return a native provider message id plus receipt.",
    );
  }

  if (
    proof.inboundReply.replyToMessageId !== proof.webRoom.roomMessageId ||
    !proof.inboundReply.visibleInWebRoom ||
    !nonBlank(proof.inboundReply.providerMessageId) ||
    !nonBlank(proof.inboundReply.senderRef) ||
    !nonBlank(proof.inboundReply.messageId) ||
    !nonBlank(proof.inboundReply.receivedAt)
  ) {
    push(
      gaps,
      "inbound_reply",
      "The user's provider reply must be threaded back into the same canonical web room.",
    );
  }

  if (
    !nonBlank(proof.approval.approvalRequestId) ||
    !nonBlank(proof.approval.command) ||
    !nonBlank(proof.approval.decidedByMemberId) ||
    !nonBlank(proof.approval.auditReceiptId) ||
    !proof.approval.executedByCanonicalApprovalPath ||
    proof.approval.selfApproval
  ) {
    push(
      gaps,
      "approval_roundtrip",
      "The external approval decision must resolve through the canonical approval path and audit receipt.",
    );
  }

  if (
    !sameRoom(proof) ||
    !sameProviderThread(proof) ||
    proof.externalDelivery.messageId !== proof.webRoom.roomMessageId
  ) {
    push(
      gaps,
      "provider_correlation",
      "Workspace, channel, provider thread, and room message ids must correlate across web, outbound, and inbound proof.",
    );
  }

  if (!proof.links.permissionSafe || !isPublicUrl(proof.links.previewUrl) || !isPublicUrl(proof.links.receiptUrl)) {
    push(
      gaps,
      "permission_safe_links",
      "Preview and receipt links must be public HTTP(S) URLs and marked permission-safe.",
    );
  }

  return { proven: gaps.length === 0, gaps };
}
