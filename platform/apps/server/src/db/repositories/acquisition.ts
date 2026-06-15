import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../index.js";
import {
  acquisitionBudgetEnvelopes,
  acquisitionSendReceipts,
  acquisitionSuppressions,
} from "../schema/index.js";
import { normalizeRecipient, type SuppressionReason } from "../../acquisition/compliance.js";
import type { AcquisitionChannel, BudgetEnvelope, EnvelopeStatus } from "../../acquisition/decide.js";
import type {
  EnvelopeStore,
  ReceiptStore,
  SendReceiptInput,
  SuppressionStore,
} from "../../acquisition/execution.js";
import type { ChannelSpend, ChannelConversions } from "../../acquisition/cac.js";

/**
 * Acquisition execution repository (#189, ADR-0189). Workspace-scoped throughout (#3 IDOR discipline).
 * Implements the dispatcher's IO seams (envelope load/debit, receipt record, suppression load) plus the
 * read models the founder brief + CAC view consume. Every metric here is external-grounded: spend +
 * conversions come from real receipt rows, never a self-reported field (premortem #200 §2/§3).
 */

// ---- budget envelope ----------------------------------------------------------------------------

function ideaEq(col: typeof acquisitionBudgetEnvelopes.ideaId, ideaId: string | null) {
  return ideaId === null ? isNull(col) : eq(col, ideaId);
}

/** The dispatcher's {@link EnvelopeStore}: load the active ads envelope + debit it after a real spend. */
export const dbEnvelopeStore: EnvelopeStore = {
  async getActiveAdsEnvelope(workspaceId, ideaId): Promise<BudgetEnvelope | null> {
    const [row] = await db
      .select({
        capCents: acquisitionBudgetEnvelopes.capCents,
        spentCents: acquisitionBudgetEnvelopes.spentCents,
        status: acquisitionBudgetEnvelopes.status,
      })
      .from(acquisitionBudgetEnvelopes)
      .where(
        and(
          eq(acquisitionBudgetEnvelopes.workspaceId, workspaceId),
          ideaEq(acquisitionBudgetEnvelopes.ideaId, ideaId),
          eq(acquisitionBudgetEnvelopes.channel, "ads"),
          eq(acquisitionBudgetEnvelopes.status, "active"),
        ),
      )
      .orderBy(desc(acquisitionBudgetEnvelopes.createdAt))
      .limit(1);
    if (!row) return null;
    return {
      capCents: row.capCents,
      spentCents: row.spentCents,
      status: row.status as EnvelopeStatus,
    };
  },

  async debitAdsEnvelope(workspaceId, ideaId, amountCents): Promise<void> {
    await db
      .update(acquisitionBudgetEnvelopes)
      .set({
        spentCents: sql`${acquisitionBudgetEnvelopes.spentCents} + ${amountCents}`,
        // Flip to exhausted once cumulative spend reaches the cap.
        status: sql`CASE WHEN ${acquisitionBudgetEnvelopes.spentCents} + ${amountCents} >= ${acquisitionBudgetEnvelopes.capCents} THEN 'exhausted' ELSE ${acquisitionBudgetEnvelopes.status} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(acquisitionBudgetEnvelopes.workspaceId, workspaceId),
          ideaEq(acquisitionBudgetEnvelopes.ideaId, ideaId),
          eq(acquisitionBudgetEnvelopes.channel, "ads"),
          eq(acquisitionBudgetEnvelopes.status, "active"),
        ),
      );
  },
};

export interface AcquisitionEnvelopeRow {
  id: string;
  ideaId: string | null;
  channel: AcquisitionChannel;
  periodKey: string;
  capCents: number;
  spentCents: number;
  status: EnvelopeStatus;
  createdAtMs: number;
}

/** Create or update an owner-approved budget envelope (upsert on the period dedupe key). */
export async function upsertBudgetEnvelope(input: {
  workspaceId: string;
  ideaId: string | null;
  channel?: AcquisitionChannel;
  periodKey: string;
  capCents: number;
  status?: EnvelopeStatus;
  approvalRequestId?: string | null;
  approvedByMemberId?: string | null;
}): Promise<void> {
  const channel = input.channel ?? "ads";
  await db
    .insert(acquisitionBudgetEnvelopes)
    .values({
      workspaceId: input.workspaceId,
      ideaId: input.ideaId,
      channel,
      periodKey: input.periodKey,
      capCents: input.capCents,
      status: input.status ?? "active",
      approvalRequestId: input.approvalRequestId ?? null,
      approvedByMemberId: input.approvedByMemberId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        acquisitionBudgetEnvelopes.workspaceId,
        acquisitionBudgetEnvelopes.ideaId,
        acquisitionBudgetEnvelopes.channel,
        acquisitionBudgetEnvelopes.periodKey,
      ],
      set: {
        capCents: input.capCents,
        status: input.status ?? "active",
        updatedAt: new Date(),
      },
    });
}

// ---- send receipts ------------------------------------------------------------------------------

/** The dispatcher's {@link ReceiptStore}: append one external-grounded send receipt. */
export const dbReceiptStore: ReceiptStore = {
  async record(receipt: SendReceiptInput): Promise<void> {
    await db.insert(acquisitionSendReceipts).values({
      workspaceId: receipt.workspaceId,
      ideaId: receipt.ideaId,
      channel: receipt.channel,
      kind: receipt.kind,
      provider: receipt.provider,
      status: receipt.status,
      externalId: receipt.externalId,
      amountCents: receipt.amountCents,
      recipientCount: receipt.recipientCount,
      detail: receipt.detail,
    });
  },
};

/** Per-channel real ad spend (cents) since `since` — the external-grounded spend the brief reads (AC5). */
export async function spendByChannelSince(
  workspaceId: string,
  since: Date,
): Promise<ChannelSpend[]> {
  const rows = await db
    .select({
      channel: acquisitionSendReceipts.channel,
      spentCents: sql<number>`COALESCE(SUM(${acquisitionSendReceipts.amountCents}), 0)`,
    })
    .from(acquisitionSendReceipts)
    .where(
      and(
        eq(acquisitionSendReceipts.workspaceId, workspaceId),
        eq(acquisitionSendReceipts.status, "sent"),
        gte(acquisitionSendReceipts.createdAt, since),
      ),
    )
    .groupBy(acquisitionSendReceipts.channel);
  return rows.map((r) => ({
    channel: r.channel as AcquisitionChannel,
    spentCents: Number(r.spentCents),
  }));
}

/**
 * Count of successfully-SENT receipts on `channel` since `since` (#253) — e.g. social posts that actually
 * went out. Counts rows, not recipients (one row = one post/send), so it's the honest "live posts" figure
 * the proof scorecard reads. Only `status = 'sent'` rows count (a `dryrun`/recorded-only send still records
 * a `sent` receipt with an `external_id`, which is the external-grounded proof the work shipped).
 */
export async function sentCountByChannelSince(
  workspaceId: string,
  channel: AcquisitionChannel,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(acquisitionSendReceipts)
    .where(
      and(
        eq(acquisitionSendReceipts.workspaceId, workspaceId),
        eq(acquisitionSendReceipts.channel, channel),
        eq(acquisitionSendReceipts.status, "sent"),
        gte(acquisitionSendReceipts.createdAt, since),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Channels whose most-recent receipt is a failure (surfaced in the brief, AC3). */
export async function failingChannelsSince(
  workspaceId: string,
  since: Date,
): Promise<string[]> {
  const rows = await db
    .select({ channel: acquisitionSendReceipts.channel })
    .from(acquisitionSendReceipts)
    .where(
      and(
        eq(acquisitionSendReceipts.workspaceId, workspaceId),
        eq(acquisitionSendReceipts.status, "failed"),
        gte(acquisitionSendReceipts.createdAt, since),
      ),
    )
    .groupBy(acquisitionSendReceipts.channel);
  return rows.map((r) => r.channel);
}

/** Today's email send count (recipients), for domain-warmup headroom. */
export async function emailSentToday(workspaceId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${acquisitionSendReceipts.recipientCount}), 0)`,
    })
    .from(acquisitionSendReceipts)
    .where(
      and(
        eq(acquisitionSendReceipts.workspaceId, workspaceId),
        eq(acquisitionSendReceipts.channel, "email"),
        eq(acquisitionSendReceipts.status, "sent"),
        gte(acquisitionSendReceipts.createdAt, since),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * The domain-warmup state for a workspace at `nowMs`: which warmup day we are on (days since the first
 * email send; 0 when none yet) and how many recipients have been sent today (UTC). Drives the in-code
 * warmup ramp in the dispatcher (a cold domain may only send a growing volume/day).
 */
export async function emailWarmupState(
  workspaceId: string,
  nowMs: number,
): Promise<{ dayIndex: number; sentToday: number }> {
  const startOfDay = new Date(new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00.000Z");
  const sentToday = await emailSentToday(workspaceId, startOfDay);
  const [first] = await db
    .select({ at: acquisitionSendReceipts.createdAt })
    .from(acquisitionSendReceipts)
    .where(
      and(
        eq(acquisitionSendReceipts.workspaceId, workspaceId),
        eq(acquisitionSendReceipts.channel, "email"),
        eq(acquisitionSendReceipts.status, "sent"),
      ),
    )
    .orderBy(acquisitionSendReceipts.createdAt)
    .limit(1);
  const dayIndex = first ? Math.floor((nowMs - first.at.getTime()) / 86_400_000) : 0;
  return { dayIndex: Math.max(0, dayIndex), sentToday };
}

// ---- suppression list ---------------------------------------------------------------------------

/** The dispatcher's {@link SuppressionStore}: load the normalized suppression set for a workspace. */
export const dbSuppressionStore: SuppressionStore = {
  async loadSuppressed(workspaceId): Promise<ReadonlySet<string>> {
    const rows = await db
      .select({ recipient: acquisitionSuppressions.recipient })
      .from(acquisitionSuppressions)
      .where(eq(acquisitionSuppressions.workspaceId, workspaceId));
    return new Set(rows.map((r) => r.recipient));
  },
};

/** Add (or upsert) a recipient to the suppression list. Normalizes the email. Idempotent. */
export async function addSuppression(input: {
  workspaceId: string;
  recipient: string;
  reason: SuppressionReason;
  source?: string;
}): Promise<void> {
  const recipient = normalizeRecipient(input.recipient);
  if (!recipient) return;
  await db
    .insert(acquisitionSuppressions)
    .values({
      workspaceId: input.workspaceId,
      recipient,
      reason: input.reason,
      source: input.source ?? "manual",
    })
    .onConflictDoUpdate({
      target: [acquisitionSuppressions.workspaceId, acquisitionSuppressions.recipient],
      set: { reason: input.reason, source: input.source ?? "manual" },
    });
}

export interface SuppressionRow {
  recipient: string;
  reason: SuppressionReason;
  source: string;
  createdAtMs: number;
}

/** List the suppression entries for a workspace (most recent first). */
export async function listSuppressions(
  workspaceId: string,
  limit = 200,
): Promise<SuppressionRow[]> {
  const rows = await db
    .select()
    .from(acquisitionSuppressions)
    .where(eq(acquisitionSuppressions.workspaceId, workspaceId))
    .orderBy(desc(acquisitionSuppressions.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    recipient: r.recipient,
    reason: r.reason as SuppressionReason,
    source: r.source,
    createdAtMs: r.createdAt.getTime(),
  }));
}

/**
 * Per-channel EXTERNAL conversions since `since`. #189 records conversions on a `sent` receipt's detail
 * (`detail.conversions`) when an external receipt confirms them; absent that, a channel reports 0
 * verified conversions. This keeps CAC grounded in receipts (premortem #200 §2) — a self-reported count
 * is never `verified`. (The growth loop #102 owns funnel conversions; this is the channel-attributed
 * slice the brief blends.)
 */
export async function conversionsByChannelSince(
  workspaceId: string,
  since: Date,
): Promise<ChannelConversions[]> {
  const rows = await db
    .select({
      channel: acquisitionSendReceipts.channel,
      conversions: sql<number>`COALESCE(SUM((${acquisitionSendReceipts.detail} ->> 'conversions')::int), 0)`,
      verified: sql<boolean>`bool_or(COALESCE((${acquisitionSendReceipts.detail} ->> 'conversionsVerified')::boolean, false))`,
    })
    .from(acquisitionSendReceipts)
    .where(
      and(
        eq(acquisitionSendReceipts.workspaceId, workspaceId),
        eq(acquisitionSendReceipts.status, "sent"),
        gte(acquisitionSendReceipts.createdAt, since),
      ),
    )
    .groupBy(acquisitionSendReceipts.channel);
  return rows
    .filter((r) => Number(r.conversions) > 0)
    .map((r) => ({
      channel: r.channel as AcquisitionChannel,
      conversions: Number(r.conversions),
      verified: Boolean(r.verified),
    }));
}
