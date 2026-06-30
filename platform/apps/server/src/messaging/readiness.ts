import type { ExternalRoomMessageProof } from "../db/repositories/external-room-message-receipts.js";
import type {
  IMessageRecipient,
  IMessageRelayHeartbeat,
  IMessageRelayInboundReceipt,
  IMessageRelayJob,
} from "../db/repositories/imessage.js";
import type { ServiceCredentialRow } from "../db/repositories/external-credentials.js";
import type { IMessageStatus } from "../imessage/types.js";

export const ROUND_TRIP_PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type MessagingReadinessProvider = "telegram" | "whatsapp" | "imessage";
export type MessagingReadinessState =
  | "disabled"
  | "config_missing"
  | "configured_unproven"
  | "outbound_sent"
  | "inbound_received"
  | "healthy";

export interface MessagingProofSummary {
  channelId: string | null;
  messageId: string | null;
  replyToMessageId?: string | null;
  providerConversationId?: string;
  providerMessageId?: string;
  createdAt: string;
  expiresAt: string;
  stale: boolean;
}

export interface MessagingReadinessDestination {
  configured: boolean;
  value: string | null;
  connectedByMemberId: string | null;
  connectedAtMs: number | null;
}

export interface MessagingProviderReadiness {
  provider: MessagingReadinessProvider;
  label: string;
  state: MessagingReadinessState;
  healthy: boolean;
  configured: boolean;
  missingConfig: string[];
  destination: MessagingReadinessDestination;
  latestOutboundProof: MessagingProofSummary | null;
  latestInboundProof: MessagingProofSummary | null;
  relayHeartbeat?: {
    active: boolean;
    messagesAccess: "unknown" | "ok" | "failed";
    messagesDbAccess: "unknown" | "ok" | "failed";
    checkedInAt: string | null;
    relayId: string | null;
    host: string | null;
  };
  notes: string[];
}

export interface MessagingReadinessReport {
  checkedAt: string;
  proofMaxAgeMs: number;
  providers: MessagingProviderReadiness[];
}

export interface ExternalProviderReadinessInput {
  provider: "telegram" | "whatsapp";
  label: string;
  configured: boolean;
  missingConfig: string[];
  connection: ServiceCredentialRow | null;
  connectedByMemberId?: string | null;
  destination: string | null;
  outboundProof?: ExternalRoomMessageProof;
  inboundProof?: ExternalRoomMessageProof;
  nowMs?: number;
}

export interface IMessageReadinessInput {
  status: IMessageStatus;
  recipient?: IMessageRecipient;
  latestSentJob?: IMessageRelayJob;
  latestInboundReceipt?: IMessageRelayInboundReceipt;
  relayHeartbeat?: IMessageRelayHeartbeat;
  nowMs?: number;
}

function expiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + ROUND_TRIP_PROOF_MAX_AGE_MS);
}

function isFresh(createdAt: Date, nowMs: number): boolean {
  return expiresAt(createdAt).getTime() > nowMs;
}

function proofSummary(proof: ExternalRoomMessageProof | undefined, nowMs: number): MessagingProofSummary | null {
  if (!proof) return null;
  return {
    channelId: proof.channelId,
    messageId: proof.messageId,
    replyToMessageId: proof.replyToMessageId,
    providerConversationId: proof.providerConversationId,
    providerMessageId: proof.providerMessageId,
    createdAt: proof.createdAt.toISOString(),
    expiresAt: expiresAt(proof.createdAt).toISOString(),
    stale: !isFresh(proof.createdAt, nowMs),
  };
}

function imessageJobProof(job: IMessageRelayJob | undefined, nowMs: number): MessagingProofSummary | null {
  if (!job?.sentAt) return null;
  return {
    channelId: job.channelId,
    messageId: job.messageId,
    createdAt: job.sentAt.toISOString(),
    expiresAt: expiresAt(job.sentAt).toISOString(),
    stale: !isFresh(job.sentAt, nowMs),
  };
}

function imessageInboundProof(
  receipt: IMessageRelayInboundReceipt | undefined,
  nowMs: number,
): MessagingProofSummary | null {
  if (!receipt) return null;
  return {
    channelId: receipt.channelId,
    messageId: receipt.messageId,
    replyToMessageId: receipt.replyToMessageId,
    createdAt: receipt.createdAt.toISOString(),
    expiresAt: expiresAt(receipt.createdAt).toISOString(),
    stale: !isFresh(receipt.createdAt, nowMs),
  };
}

function roundTripState(input: {
  configured: boolean;
  outbound: MessagingProofSummary | null;
  inbound: MessagingProofSummary | null;
}): MessagingReadinessState {
  if (!input.configured) return "config_missing";
  const outboundFresh = Boolean(input.outbound && !input.outbound.stale);
  const inboundFresh = Boolean(input.inbound && !input.inbound.stale);
  if (outboundFresh && inboundFresh) return "healthy";
  if (outboundFresh) return "outbound_sent";
  if (inboundFresh) return "inbound_received";
  return "configured_unproven";
}

export function normalizeTelegramDestination(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return /^-?[0-9]{3,32}$/.test(value) ? value : null;
}

export function normalizeWhatsAppDestination(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[ +().-]/g, "").trim();
  return /^[0-9]{7,18}$/.test(value) ? value : null;
}

export function buildExternalProviderReadiness(input: ExternalProviderReadinessInput): MessagingProviderReadiness {
  const nowMs = input.nowMs ?? Date.now();
  const outbound = proofSummary(input.outboundProof, nowMs);
  const inbound = proofSummary(input.inboundProof, nowMs);
  const inboundCorrelatesToOutbound = Boolean(
    outbound &&
    inbound &&
    inbound.channelId === outbound.channelId &&
    inbound.providerConversationId === outbound.providerConversationId &&
    inbound.replyToMessageId === outbound.messageId,
  );
  const destinationConfigured = Boolean(input.destination);
  const configured = input.configured && Boolean(input.connection?.connected) && destinationConfigured;
  const state = roundTripState({
    configured,
    outbound,
    inbound: inboundCorrelatesToOutbound ? inbound : null,
  });
  const notes: string[] = [];
  if (input.missingConfig.length > 0) notes.push("deployment config missing: " + input.missingConfig.join(", "));
  if (!input.connection?.connected) notes.push("workspace has not connected a " + input.label + " destination");
  if (input.connection?.connected && !destinationConfigured) notes.push("connected credential is missing the room destination");
  if (outbound?.stale) notes.push("latest outbound proof is stale");
  if (inbound?.stale) notes.push("latest inbound proof is stale");
  if (outbound && inbound && !inboundCorrelatesToOutbound) {
    notes.push("latest inbound proof is not threaded to the latest outbound room message");
  }
  if (configured && state !== "healthy") notes.push("send and reply in the same external room to complete round-trip proof");

  return {
    provider: input.provider,
    label: input.label,
    state,
    healthy: state === "healthy",
    configured,
    missingConfig: input.missingConfig,
    destination: {
      configured: destinationConfigured,
      value: input.destination,
      connectedByMemberId: input.connectedByMemberId ?? null,
      connectedAtMs: input.connection?.connectedAtMs ?? null,
    },
    latestOutboundProof: outbound,
    latestInboundProof: inbound,
    notes,
  };
}

export function buildIMessageReadiness(input: IMessageReadinessInput): MessagingProviderReadiness {
  const nowMs = input.nowMs ?? Date.now();
  const outbound = imessageJobProof(input.latestSentJob, nowMs);
  const inbound = imessageInboundProof(input.latestInboundReceipt, nowMs);
  const inboundCorrelatesToOutbound = Boolean(
    outbound &&
    inbound &&
    inbound.channelId === outbound.channelId &&
    inbound.replyToMessageId === outbound.messageId,
  );
  const heartbeatFresh = Boolean(input.relayHeartbeat && nowMs - input.relayHeartbeat.checkedInAt.getTime() <= 120_000);
  const messagesAccess = input.relayHeartbeat?.messagesAccess ?? "unknown";
  const messagesDbAccess = input.relayHeartbeat?.messagesDbAccess ?? "unknown";
  const relayReady = heartbeatFresh && messagesAccess === "ok" && messagesDbAccess === "ok";
  const configured = input.status.enabled && input.status.configured && !input.status.dryRun && Boolean(input.recipient?.verifiedAt);
  const missingConfig: string[] = [];
  let state: MessagingReadinessState = roundTripState({
    configured,
    outbound,
    inbound: inboundCorrelatesToOutbound ? inbound : null,
  });
  const notes: string[] = [];

  if (!input.status.enabled) {
    state = "disabled";
    missingConfig.push("iMessage_relay_enabled");
    notes.push("iMessage relay is disabled for this deployment");
  } else if (input.status.dryRun) {
    state = "disabled";
    missingConfig.push("iMessage_relay_live_mode");
    notes.push("iMessage relay is in dry-run mode");
  } else if (!input.status.configured) {
    state = "config_missing";
    missingConfig.push("verified_iMessage_recipient");
    notes.push(
      input.status.requiresVerification
        ? "member iMessage recipient still needs a successful verification send"
        : "verified iMessage recipient is missing",
    );
  } else if (state === "healthy" && !relayReady) {
    state = "configured_unproven";
  }
  if (!input.recipient?.verifiedAt && !missingConfig.includes("verified_iMessage_recipient")) {
    missingConfig.push("verified_iMessage_recipient");
  }
  if (!heartbeatFresh) {
    missingConfig.push("active_iMessage_relay");
    notes.push("signed Mac relay heartbeat is not active");
  }
  if (heartbeatFresh && messagesAccess === "failed") {
    missingConfig.push("iMessage_messages_access");
    notes.push("signed Mac relay cannot control Messages; grant Messages Automation and keep Messages open");
  }
  if (heartbeatFresh && messagesAccess === "unknown") {
    missingConfig.push("iMessage_messages_access");
    notes.push("signed Mac relay Messages send access is not proven");
  }
  if (heartbeatFresh && messagesDbAccess === "failed") {
    missingConfig.push("iMessage_messages_db_access");
    notes.push(
      "signed Mac relay cannot read Messages replies; grant Full Disk Access or set IMESSAGE_MESSAGES_DB_PATH",
    );
  }
  if (heartbeatFresh && messagesDbAccess === "unknown") {
    missingConfig.push("iMessage_messages_db_access");
    notes.push("signed Mac relay Messages reply-sync access is not proven");
  }
  if (outbound?.stale) notes.push("latest iMessage outbound proof is stale");
  if (inbound?.stale) notes.push("latest iMessage inbound proof is stale");
  if (outbound && inbound && !inboundCorrelatesToOutbound) {
    notes.push("latest iMessage inbound proof is not threaded to the latest outbound room message");
  }
  if (configured && state !== "healthy") notes.push("send and reply through iMessage to complete round-trip proof");

  return {
    provider: "imessage",
    label: "iMessage",
    state,
    healthy: state === "healthy",
    configured,
    missingConfig,
    destination: {
      configured: Boolean(input.recipient?.verifiedAt),
      value: input.recipient?.recipient ?? input.status.recipient ?? null,
      connectedByMemberId: input.recipient?.memberId ?? null,
      connectedAtMs: input.recipient?.verifiedAt?.getTime() ?? null,
    },
    latestOutboundProof: outbound,
    latestInboundProof: inbound,
    relayHeartbeat: {
      active: heartbeatFresh,
      messagesAccess,
      messagesDbAccess,
      checkedInAt: input.relayHeartbeat?.checkedInAt.toISOString() ?? null,
      relayId: input.relayHeartbeat?.relayId ?? null,
      host: input.relayHeartbeat?.host ?? null,
    },
    notes,
  };
}

export function buildMessagingReadinessReport(input: {
  providers: MessagingProviderReadiness[];
  nowMs?: number;
}): MessagingReadinessReport {
  const nowMs = input.nowMs ?? Date.now();
  return {
    checkedAt: new Date(nowMs).toISOString(),
    proofMaxAgeMs: ROUND_TRIP_PROOF_MAX_AGE_MS,
    providers: input.providers,
  };
}
