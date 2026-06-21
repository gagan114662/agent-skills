import { tokenFingerprint } from "../crypto/secretbox.js";
import { getChannelDescriptor, LOWEST_RISK_CHANNEL, type OutboundChannel } from "./channel.js";
import { buildEspReadbackReceipt, buildLiveUrlReceipt, isExternalReceipt, type ExternalReceipt } from "./receipt.js";
import type { OutboundReceiptSource } from "./constants.js";
import {
  getChannelConnection,
  recordSendReceipt,
  upsertChannelConnection,
  type ChannelConnectionRow,
  type SendReceiptRow,
} from "../db/repositories/outbound-channels.js";

/**
 * The outbound-channel service (issue #395) — the IO orchestrator that ties the connect-once step and the
 * #200 §3 readback-receipt verification to the ledger. Two responsibilities:
 *
 *   1. connectChannel  — record the owner's connect-once consent. The live credential (the Postmark server
 *                        token) is OWNER-GATED: it is read inline from the deployment env at call time and
 *                        NEVER persisted, logged, or returned — only its non-reversible fingerprint is
 *                        stored as proof of connection. With no credential set, connect refuses and points
 *                        the owner at the one manual step (`fly secrets set POSTMARK_SERVER_TOKEN=...`).
 *   2. verifyAndRecordSend — after a send, confirm it actually reached reality and record the receipt.
 *                        Verification TOUCHES REALITY through an injected probe (a delivery read-back or a
 *                        live-URL probe); only a receipt that passes `isExternalReceipt` is marked verified.
 *                        The default probe returns nothing — no readback wired yet means no fabricated proof.
 */

export interface ConnectChannelInput {
  workspaceId: string;
  /** Defaults to the lowest-risk channel (#395 ships email only). */
  channel?: OutboundChannel;
  /** The verified DKIM-signed From address. */
  fromAddress: string;
  /** The member who performed the owner consent. */
  connectedByMemberId: string | null;
  /** Test/owner-flow override for the credential read. Production reads it from the env var inline. */
  serverToken?: string;
  /** Injected for tests; defaults to `process.env`. The token is read from here, never written back. */
  env?: NodeJS.ProcessEnv;
  /** Injected clock; defaults to `Date.now`. */
  now?: () => number;
}

export type ConnectChannelResult =
  | { ok: true; connection: ChannelConnectionRow }
  | { ok: false; code: "unknown_channel" | "missing_from" | "missing_credential"; error: string };

/**
 * Record the owner's connect-once consent for a channel. Reads the owner-gated credential inline, stores
 * ONLY its fingerprint (never the token), and flips the ledger to `connected`. Returns a clear, actionable
 * error (no internal chatter) when the owner has not yet set the credential.
 */
export async function connectChannel(input: ConnectChannelInput): Promise<ConnectChannelResult> {
  const channel = input.channel ?? LOWEST_RISK_CHANNEL;
  const descriptor = getChannelDescriptor(channel);
  if (!descriptor) {
    return { ok: false, code: "unknown_channel", error: `Unknown channel: ${channel}` };
  }
  const fromAddress = (input.fromAddress ?? "").trim();
  if (fromAddress === "") {
    return { ok: false, code: "missing_from", error: "A verified sending From address is required to connect." };
  }
  const env = input.env ?? process.env;
  // The credential is OWNER-GATED: read inline, never persisted. Test/owner flows may pass it explicitly.
  const serverToken = (input.serverToken ?? env[descriptor.credentialEnvKey] ?? "").trim();
  if (serverToken === "") {
    return {
      ok: false,
      code: "missing_credential",
      error: `Not connected: the owner must set ${descriptor.credentialEnvKey} (e.g. \`fly secrets set ${descriptor.credentialEnvKey}=...\`) before this channel can send.`,
    };
  }
  const at = new Date(input.now ? input.now() : Date.now());
  const connection = await upsertChannelConnection({
    workspaceId: input.workspaceId,
    channel,
    provider: descriptor.provider,
    status: "connected",
    fromAddress,
    // Proof of connection WITHOUT the secret — a sha256 slice, never the token itself.
    credentialFingerprint: tokenFingerprint(serverToken),
    connectedByMemberId: input.connectedByMemberId,
    at,
  });
  return { ok: true, connection };
}

/** Revoke a channel connection (the owner disconnected). Drops the fingerprint/from; the channel can no longer send. */
export async function revokeChannel(input: {
  workspaceId: string;
  channel?: OutboundChannel;
  now?: () => number;
}): Promise<ChannelConnectionRow> {
  const channel = input.channel ?? LOWEST_RISK_CHANNEL;
  const descriptor = getChannelDescriptor(channel);
  const at = new Date(input.now ? input.now() : Date.now());
  return upsertChannelConnection({
    workspaceId: input.workspaceId,
    channel,
    provider: descriptor?.provider ?? channel,
    status: "revoked",
    fromAddress: null,
    credentialFingerprint: null,
    connectedByMemberId: null,
    at,
  });
}

/** Whether `credentialEnvKey` for a channel is present in the env (a boolean — never the value). */
export function isCredentialPresent(channel: OutboundChannel, env: NodeJS.ProcessEnv = process.env): boolean {
  const descriptor = getChannelDescriptor(channel);
  if (!descriptor) return false;
  return (env[descriptor.credentialEnvKey] ?? "").trim() !== "";
}

export { getChannelConnection };

/** A single read-back observation from the world after a send. One of `messageId` (ESP) or `url` (probe). */
export interface SendReadback {
  /** A production read-back: the ESP message id (e.g. Postmark `MessageID`). */
  messageId?: string;
  /** A live-URL probe: the URL reality was probed at. */
  url?: string;
  /** For a `url` readback: the HTTP status the probe returned. */
  httpStatus?: number;
  /** ISO timestamp at which reality was observed. */
  observedAt: string;
  /** Structured detail for the audit trail. */
  detail?: Record<string, unknown>;
}

export interface VerifySendContext {
  workspaceId: string;
  channel: OutboundChannel;
  recipient: string;
  approvalRequestId: string | null;
}

/** A probe that TOUCHES REALITY to confirm a send landed. Returns `null` when nothing can be read back. */
export type ReadbackProbe = (ctx: VerifySendContext) => Promise<SendReadback | null>;

export interface VerifyAndRecordSendInput {
  workspaceId: string;
  channel?: OutboundChannel;
  recipient: string;
  approvalRequestId: string | null;
  /** The reality-touching probe; defaults to a no-op (no readback wired ⇒ no fabricated proof). */
  probe?: ReadbackProbe;
}

export type VerifyAndRecordSendResult = {
  /** True only when a production-grounded receipt passed `isExternalReceipt` (#200 §3). */
  verified: boolean;
  /** Whether a receipt row was persisted (an attempt with a real external ref is recorded either way). */
  recorded: boolean;
  receipt: ExternalReceipt | null;
  row: SendReceiptRow | null;
};

/**
 * The #200 §3 readback-receipt verification path. Runs the injected probe, builds the appropriate receipt,
 * runs it through the single `isExternalReceipt` predicate, and persists the result tied to the #13 approval
 * that authorized the send. A real send reached a real inbox ⇔ a `production_readback` receipt carrying the
 * ESP message id passes the predicate. Never assumes success: with no probe / no readback, nothing is marked
 * verified.
 */
export async function verifyAndRecordSend(input: VerifyAndRecordSendInput): Promise<VerifyAndRecordSendResult> {
  const channel = input.channel ?? LOWEST_RISK_CHANNEL;
  const ctx: VerifySendContext = {
    workspaceId: input.workspaceId,
    channel,
    recipient: input.recipient,
    approvalRequestId: input.approvalRequestId,
  };
  const probe = input.probe ?? (async () => null);
  const raw = await probe(ctx);
  if (!raw) return { verified: false, recorded: false, receipt: null, row: null };

  let source: OutboundReceiptSource;
  let externalRef: string;
  let httpStatus: number | null;
  let receipt: ExternalReceipt | null;
  if (raw.messageId !== undefined) {
    source = "production_readback";
    externalRef = raw.messageId.trim();
    httpStatus = null;
    receipt = buildEspReadbackReceipt({ messageId: raw.messageId, observedAt: raw.observedAt, detail: raw.detail });
  } else if (raw.url !== undefined) {
    source = "live_url";
    externalRef = raw.url.trim();
    httpStatus = typeof raw.httpStatus === "number" ? raw.httpStatus : null;
    receipt = buildLiveUrlReceipt({
      url: raw.url,
      httpStatus: raw.httpStatus ?? 0,
      observedAt: raw.observedAt,
      detail: raw.detail,
    });
  } else {
    return { verified: false, recorded: false, receipt: null, row: null };
  }

  // Without a real external reference there is nothing to persist (no fabricated row).
  if (externalRef === "") return { verified: false, recorded: false, receipt: null, row: null };

  const verified = receipt !== null && isExternalReceipt(receipt);
  const observedDate = new Date(raw.observedAt);
  const row = await recordSendReceipt({
    workspaceId: input.workspaceId,
    channel,
    approvalRequestId: input.approvalRequestId,
    recipient: input.recipient,
    source,
    externalRef,
    httpStatus,
    verified,
    detail: raw.detail ?? null,
    observedAt: Number.isNaN(observedDate.getTime()) ? new Date() : observedDate,
  });
  return { verified, recorded: true, receipt, row };
}
