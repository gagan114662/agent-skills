import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import {
  DELIVERABLE_FEEDBACK_CATEGORIES,
  DELIVERABLE_PERFORMANCE_SOURCES,
  deliverableFeedback,
  deliverablePerformance,
  deliveryReceipts,
} from "../schema/index.js";
import type { DeliveryReceiptInput, DeliveryReceiptStore } from "../../delivery/dispatcher.js";

/**
 * Deliverable delivery receipts repository (#295). Implements the {@link DeliveryReceiptStore} seam the
 * dispatcher writes through on every shipped (or failed) deliverable, plus the workspace-scoped reads the
 * founder console uses to surface "what the fleet actually shipped" honestly. Tenant-scoped throughout (#3).
 */
export const dbDeliveryReceiptStore: DeliveryReceiptStore = {
  async record(input: DeliveryReceiptInput): Promise<{ id: string }> {
    const [row] = await db
      .insert(deliveryReceipts)
      .values({
        workspaceId: input.workspaceId,
        approvalRequestId: input.approvalRequestId,
        sessionId: input.sessionId,
        channel: input.channel,
        reversibility: input.reversibility,
        provider: input.provider,
        live: input.live,
        computeSeconds: input.computeSeconds ?? 0,
        estimatedCostCents: input.estimatedCostCents ?? 0,
        externalRef: input.externalRef,
        status: input.status,
        detail: input.detail,
      })
      .returning({ id: deliveryReceipts.id });
    return { id: row?.id ?? "" };
  },
};

export interface DeliveryReceiptRow {
  id: string;
  approvalRequestId: string;
  sessionId: string | null;
  channel: string;
  reversibility: string;
  provider: string;
  live: boolean;
  computeSeconds: number;
  estimatedCostCents: number;
  externalRef: string | null;
  status: string;
  shippedAtMs: number;
}

export type DeliverableFeedbackCategory = (typeof DELIVERABLE_FEEDBACK_CATEGORIES)[number];
export type DeliverablePerformanceSource = (typeof DELIVERABLE_PERFORMANCE_SOURCES)[number];

export interface DeliverableFeedbackRow {
  id: string;
  workspaceId: string;
  deliveryReceiptId: string;
  rating: number;
  category: DeliverableFeedbackCategory;
  comment: string | null;
  alertNotifiedAtMs: number | null;
  createdAtMs: number;
}

export interface DeliverableFeedbackSummary {
  count: number;
  averageRating: number | null;
  lowRatingCount: number;
  latestLowRating: DeliverableFeedbackRow | null;
}

function toFeedbackRow(row: typeof deliverableFeedback.$inferSelect): DeliverableFeedbackRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    deliveryReceiptId: row.deliveryReceiptId,
    rating: row.rating,
    category: row.category as DeliverableFeedbackCategory,
    comment: row.comment,
    alertNotifiedAtMs: row.alertNotifiedAt ? row.alertNotifiedAt.getTime() : null,
    createdAtMs: row.createdAt.getTime(),
  };
}

export interface DeliverablePerformanceRow {
  id: string;
  workspaceId: string;
  deliveryReceiptId: string;
  source: DeliverablePerformanceSource;
  views: number;
  engagements: number;
  conversions: number;
  externalMetricRef: string | null;
  measuredAtMs: number;
  createdAtMs: number;
}

export interface DeliverablePerformanceSummary {
  deliveryReceiptId: string;
  receipt: DeliveryReceiptRow | null;
  totals: {
    views: number;
    engagements: number;
    conversions: number;
    engagementRate: number | null;
    conversionRate: number | null;
  };
  latest: DeliverablePerformanceRow | null;
  readings: DeliverablePerformanceRow[];
}

export interface RankedDeliverablePerformance {
  deliveryReceiptId: string;
  receipt: DeliveryReceiptRow;
  views: number;
  engagements: number;
  conversions: number;
  engagementRate: number | null;
  conversionRate: number | null;
  latestMeasuredAtMs: number | null;
}

function toReceiptRow(row: typeof deliveryReceipts.$inferSelect): DeliveryReceiptRow {
  return {
    id: row.id,
    approvalRequestId: row.approvalRequestId,
    sessionId: row.sessionId,
    channel: row.channel,
    reversibility: row.reversibility,
    provider: row.provider,
    live: row.live,
    computeSeconds: row.computeSeconds,
    estimatedCostCents: row.estimatedCostCents,
    externalRef: row.externalRef,
    status: row.status,
    shippedAtMs: row.shippedAt.getTime(),
  };
}

function toPerformanceRow(row: typeof deliverablePerformance.$inferSelect): DeliverablePerformanceRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    deliveryReceiptId: row.deliveryReceiptId,
    source: row.source as DeliverablePerformanceSource,
    views: row.views,
    engagements: row.engagements,
    conversions: row.conversions,
    externalMetricRef: row.externalMetricRef,
    measuredAtMs: row.measuredAt.getTime(),
    createdAtMs: row.createdAt.getTime(),
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

function summarizeRows(
  deliveryReceiptId: string,
  receipt: DeliveryReceiptRow | null,
  rows: DeliverablePerformanceRow[],
): DeliverablePerformanceSummary {
  const totals = rows.reduce(
    (acc, row) => ({
      views: acc.views + row.views,
      engagements: acc.engagements + row.engagements,
      conversions: acc.conversions + row.conversions,
    }),
    { views: 0, engagements: 0, conversions: 0 },
  );
  return {
    deliveryReceiptId,
    receipt,
    totals: {
      ...totals,
      engagementRate: rate(totals.engagements, totals.views),
      conversionRate: rate(totals.conversions, totals.views),
    },
    latest: rows[0] ?? null,
    readings: rows,
  };
}

/** The most recent delivery receipts for a workspace (the console's "what shipped" feed). */
export async function listDeliveryReceipts(
  workspaceId: string,
  limit = 50,
): Promise<DeliveryReceiptRow[]> {
  const rows = await db
    .select()
    .from(deliveryReceipts)
    .where(eq(deliveryReceipts.workspaceId, workspaceId))
    .orderBy(desc(deliveryReceipts.shippedAt))
    .limit(limit);
  return rows.map(toReceiptRow);
}

export async function recordDeliverablePerformance(input: {
  workspaceId: string;
  deliveryReceiptId: string;
  source: DeliverablePerformanceSource;
  views: number;
  engagements: number;
  conversions: number;
  externalMetricRef: string | null;
  measuredAt: Date;
}): Promise<{ performance: DeliverablePerformanceRow; receipt: DeliveryReceiptRow } | null> {
  const [receipt] = await db
    .select()
    .from(deliveryReceipts)
    .where(and(eq(deliveryReceipts.workspaceId, input.workspaceId), eq(deliveryReceipts.id, input.deliveryReceiptId)))
    .limit(1);
  if (!receipt || receipt.status !== "shipped") return null;

  const [row] = await db
    .insert(deliverablePerformance)
    .values({
      workspaceId: receipt.workspaceId,
      deliveryReceiptId: receipt.id,
      source: input.source,
      views: input.views,
      engagements: input.engagements,
      conversions: input.conversions,
      externalMetricRef: input.externalMetricRef,
      measuredAt: input.measuredAt,
    })
    .returning();
  return row ? { performance: toPerformanceRow(row), receipt: toReceiptRow(receipt) } : null;
}

export async function getDeliverablePerformance(
  workspaceId: string,
  deliveryReceiptId: string,
  limit = 100,
): Promise<DeliverablePerformanceSummary | null> {
  const [receipt] = await db
    .select()
    .from(deliveryReceipts)
    .where(and(eq(deliveryReceipts.workspaceId, workspaceId), eq(deliveryReceipts.id, deliveryReceiptId)))
    .limit(1);
  if (!receipt) return null;
  const rows = await db
    .select()
    .from(deliverablePerformance)
    .where(
      and(
        eq(deliverablePerformance.workspaceId, workspaceId),
        eq(deliverablePerformance.deliveryReceiptId, deliveryReceiptId),
      ),
    )
    .orderBy(desc(deliverablePerformance.measuredAt))
    .limit(limit);
  return summarizeRows(deliveryReceiptId, toReceiptRow(receipt), rows.map(toPerformanceRow));
}

export async function listRankedDeliverablePerformance(
  workspaceId: string,
  limit = 25,
): Promise<RankedDeliverablePerformance[]> {
  const receipts = await listDeliveryReceipts(workspaceId, 200);
  const rows = await db
    .select()
    .from(deliverablePerformance)
    .where(eq(deliverablePerformance.workspaceId, workspaceId))
    .orderBy(desc(deliverablePerformance.measuredAt))
    .limit(1_000);
  const byReceipt = new Map<string, DeliverablePerformanceRow[]>();
  for (const row of rows.map(toPerformanceRow)) {
    const bucket = byReceipt.get(row.deliveryReceiptId) ?? [];
    bucket.push(row);
    byReceipt.set(row.deliveryReceiptId, bucket);
  }
  return receipts
    .map((receipt) => {
      const summary = summarizeRows(receipt.id, receipt, byReceipt.get(receipt.id) ?? []);
      return {
        deliveryReceiptId: receipt.id,
        receipt,
        views: summary.totals.views,
        engagements: summary.totals.engagements,
        conversions: summary.totals.conversions,
        engagementRate: summary.totals.engagementRate,
        conversionRate: summary.totals.conversionRate,
        latestMeasuredAtMs: summary.latest?.measuredAtMs ?? null,
      };
    })
    .filter((row) => row.views > 0 || row.engagements > 0 || row.conversions > 0)
    .sort((a, b) =>
      b.conversions - a.conversions ||
      b.engagements - a.engagements ||
      b.views - a.views ||
      (b.latestMeasuredAtMs ?? 0) - (a.latestMeasuredAtMs ?? 0),
    )
    .slice(0, limit);
}

export async function recordDeliverableFeedback(input: {
  deliveryReceiptId: string;
  rating: number;
  category: DeliverableFeedbackCategory;
  comment: string | null;
}): Promise<{ feedback: DeliverableFeedbackRow; receipt: DeliveryReceiptRow } | null> {
  const [receipt] = await db
    .select()
    .from(deliveryReceipts)
    .where(eq(deliveryReceipts.id, input.deliveryReceiptId))
    .limit(1);
  if (!receipt || receipt.status !== "shipped") return null;

  const [row] = await db
    .insert(deliverableFeedback)
    .values({
      workspaceId: receipt.workspaceId,
      deliveryReceiptId: receipt.id,
      rating: input.rating,
      category: input.category,
      comment: input.comment,
    })
    .returning();
  if (!row) return null;
  return {
    feedback: toFeedbackRow(row),
    receipt: toReceiptRow(receipt),
  };
}

export async function markDeliverableFeedbackAlerted(id: string): Promise<void> {
  await db
    .update(deliverableFeedback)
    .set({ alertNotifiedAt: new Date() })
    .where(eq(deliverableFeedback.id, id));
}

export async function summarizeDeliverableFeedback(
  workspaceId: string,
  limit = 200,
): Promise<DeliverableFeedbackSummary> {
  const rows = await db
    .select()
    .from(deliverableFeedback)
    .where(eq(deliverableFeedback.workspaceId, workspaceId))
    .orderBy(desc(deliverableFeedback.createdAt))
    .limit(limit);
  const feedback = rows.map(toFeedbackRow);
  const count = feedback.length;
  const low = feedback.filter((row) => row.rating <= 2);
  return {
    count,
    averageRating:
      count === 0
        ? null
        : Math.round((feedback.reduce((sum, row) => sum + row.rating, 0) / count) * 10) / 10,
    lowRatingCount: low.length,
    latestLowRating: low[0] ?? null,
  };
}

/** Count of deliverables that genuinely went LIVE (the honest "real work shipped" signal — `live=true`). */
export async function countLiveDeliveries(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: deliveryReceipts.id })
    .from(deliveryReceipts)
    .where(and(eq(deliveryReceipts.workspaceId, workspaceId), eq(deliveryReceipts.live, true)));
  return rows.length;
}
