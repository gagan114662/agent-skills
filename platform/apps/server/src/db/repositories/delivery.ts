import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import {
  DELIVERABLE_FEEDBACK_CATEGORIES,
  deliverableFeedback,
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
  externalRef: string | null;
  status: string;
  shippedAtMs: number;
}

export type DeliverableFeedbackCategory = (typeof DELIVERABLE_FEEDBACK_CATEGORIES)[number];

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
  return rows.map((r) => ({
    id: r.id,
    approvalRequestId: r.approvalRequestId,
    sessionId: r.sessionId,
    channel: r.channel,
    reversibility: r.reversibility,
    provider: r.provider,
    live: r.live,
    externalRef: r.externalRef,
    status: r.status,
    shippedAtMs: r.shippedAt.getTime(),
  }));
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
    receipt: {
      id: receipt.id,
      approvalRequestId: receipt.approvalRequestId,
      sessionId: receipt.sessionId,
      channel: receipt.channel,
      reversibility: receipt.reversibility,
      provider: receipt.provider,
      live: receipt.live,
      externalRef: receipt.externalRef,
      status: receipt.status,
      shippedAtMs: receipt.shippedAt.getTime(),
    },
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
