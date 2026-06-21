import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import {
  outboundChannels,
  outboundSendReceipts,
  type OutboundChannel,
  type OutboundChannelStatus,
  type OutboundReceiptSource,
} from "../schema/index.js";

/**
 * The outbound-channel connect + receipt repository (issue #395). Workspace-scoped throughout (the #3 IDOR
 * discipline). Persistence only — the structural always-gate (#200 §3/§4) and the credential handling live
 * in the service layer. This table holds NO secret: a connection row carries only a non-reversible
 * credential fingerprint, never the token (the token stays owner-gated in env / the #192 vault).
 */

export interface ChannelConnectionRow {
  id: string;
  workspaceId: string;
  channel: OutboundChannel;
  provider: string;
  status: OutboundChannelStatus;
  fromAddress: string | null;
  credentialFingerprint: string | null;
  connectedByMemberId: string | null;
  connectedAtMs: number | null;
  revokedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface UpsertChannelConnectionInput {
  workspaceId: string;
  channel: OutboundChannel;
  provider: string;
  status: OutboundChannelStatus;
  fromAddress: string | null;
  /** A non-reversible fingerprint of the connected credential — NEVER the credential itself. */
  credentialFingerprint: string | null;
  connectedByMemberId: string | null;
  /** Observed time for the connect/revoke transition (passed in by the caller; never read from a clock). */
  at: Date;
}

function mapConnection(r: typeof outboundChannels.$inferSelect): ChannelConnectionRow {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    channel: r.channel,
    provider: r.provider,
    status: r.status,
    fromAddress: r.fromAddress,
    credentialFingerprint: r.credentialFingerprint,
    connectedByMemberId: r.connectedByMemberId,
    connectedAtMs: r.connectedAt ? r.connectedAt.getTime() : null,
    revokedAtMs: r.revokedAt ? r.revokedAt.getTime() : null,
    createdAtMs: r.createdAt.getTime(),
    updatedAtMs: r.updatedAt.getTime(),
  };
}

/**
 * Upsert the connection ledger row for (workspace, channel). On `connected`, stamps `connected_at` and
 * clears `revoked_at`; on `revoked`, stamps `revoked_at` and drops the fingerprint/from (the credential is
 * gone). Idempotent on the (workspace, channel) unique index.
 */
export async function upsertChannelConnection(
  input: UpsertChannelConnectionInput,
): Promise<ChannelConnectionRow> {
  const connectedAt = input.status === "connected" ? input.at : null;
  const revokedAt = input.status === "revoked" ? input.at : null;
  const [row] = await db
    .insert(outboundChannels)
    .values({
      workspaceId: input.workspaceId,
      channel: input.channel,
      provider: input.provider,
      status: input.status,
      fromAddress: input.fromAddress,
      credentialFingerprint: input.credentialFingerprint,
      connectedByMemberId: input.connectedByMemberId,
      connectedAt,
      revokedAt,
      updatedAt: input.at,
    })
    .onConflictDoUpdate({
      target: [outboundChannels.workspaceId, outboundChannels.channel],
      set: {
        provider: input.provider,
        status: input.status,
        fromAddress: input.fromAddress,
        credentialFingerprint: input.credentialFingerprint,
        connectedByMemberId: input.connectedByMemberId,
        connectedAt,
        revokedAt,
        updatedAt: input.at,
      },
    })
    .returning();
  return mapConnection(row!);
}

/** Read the connection ledger row for (workspace, channel), or `null` if it has never been connected. */
export async function getChannelConnection(
  workspaceId: string,
  channel: OutboundChannel,
): Promise<ChannelConnectionRow | null> {
  const [row] = await db
    .select()
    .from(outboundChannels)
    .where(and(eq(outboundChannels.workspaceId, workspaceId), eq(outboundChannels.channel, channel)))
    .limit(1);
  return row ? mapConnection(row) : null;
}

/** List every connection ledger row for a workspace. */
export async function listChannelConnections(workspaceId: string): Promise<ChannelConnectionRow[]> {
  const rows = await db
    .select()
    .from(outboundChannels)
    .where(eq(outboundChannels.workspaceId, workspaceId))
    .orderBy(desc(outboundChannels.updatedAt))
    .limit(100);
  return rows.map(mapConnection);
}

export interface SendReceiptRow {
  id: string;
  workspaceId: string;
  channel: OutboundChannel;
  approvalRequestId: string | null;
  recipient: string;
  source: OutboundReceiptSource;
  externalRef: string;
  httpStatus: number | null;
  verified: boolean;
  detail: Record<string, unknown> | null;
  observedAtMs: number;
  createdAtMs: number;
}

export interface RecordSendReceiptInput {
  workspaceId: string;
  channel: OutboundChannel;
  approvalRequestId: string | null;
  recipient: string;
  source: OutboundReceiptSource;
  externalRef: string;
  httpStatus: number | null;
  /** Whether the receipt passed the #200 §3 predicate. The service sets this from `isExternalReceipt`. */
  verified: boolean;
  detail: Record<string, unknown> | null;
  observedAt: Date;
}

function mapReceipt(r: typeof outboundSendReceipts.$inferSelect): SendReceiptRow {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    channel: r.channel,
    approvalRequestId: r.approvalRequestId,
    recipient: r.recipient,
    source: r.source,
    externalRef: r.externalRef,
    httpStatus: r.httpStatus,
    verified: r.verified,
    detail: (r.detail as Record<string, unknown> | null) ?? null,
    observedAtMs: r.observedAt.getTime(),
    createdAtMs: r.createdAt.getTime(),
  };
}

/** Append a readback receipt (the #200 §3 proof). Append-only — every send attempt is its own row. */
export async function recordSendReceipt(input: RecordSendReceiptInput): Promise<SendReceiptRow> {
  const [row] = await db
    .insert(outboundSendReceipts)
    .values({
      workspaceId: input.workspaceId,
      channel: input.channel,
      approvalRequestId: input.approvalRequestId,
      recipient: input.recipient,
      source: input.source,
      externalRef: input.externalRef,
      httpStatus: input.httpStatus,
      verified: input.verified,
      detail: input.detail ?? undefined,
      observedAt: input.observedAt,
    })
    .returning();
  return mapReceipt(row!);
}

/** List a workspace's send receipts, newest first; pass `verifiedOnly` to see only proven-delivered sends. */
export async function listSendReceipts(
  workspaceId: string,
  opts: { verifiedOnly?: boolean } = {},
): Promise<SendReceiptRow[]> {
  const conds = [eq(outboundSendReceipts.workspaceId, workspaceId)];
  if (opts.verifiedOnly) conds.push(eq(outboundSendReceipts.verified, true));
  const rows = await db
    .select()
    .from(outboundSendReceipts)
    .where(and(...conds))
    .orderBy(desc(outboundSendReceipts.createdAt))
    .limit(500);
  return rows.map(mapReceipt);
}

/** Count a workspace's verified-delivery receipts — the revenue-blocker truth: "did a real send land?" */
export async function countVerifiedReceipts(workspaceId: string, channel: OutboundChannel): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outboundSendReceipts)
    .where(
      and(
        eq(outboundSendReceipts.workspaceId, workspaceId),
        eq(outboundSendReceipts.channel, channel),
        eq(outboundSendReceipts.verified, true),
      ),
    );
  return row?.n ?? 0;
}
