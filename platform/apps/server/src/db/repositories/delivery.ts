import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { deliveryReceipts } from "../schema/index.js";
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

/** Count of deliverables that genuinely went LIVE (the honest "real work shipped" signal — `live=true`). */
export async function countLiveDeliveries(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: deliveryReceipts.id })
    .from(deliveryReceipts)
    .where(and(eq(deliveryReceipts.workspaceId, workspaceId), eq(deliveryReceipts.live, true)));
  return rows.length;
}
