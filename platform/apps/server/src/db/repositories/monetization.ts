import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../index.js";
import { monetizationPlans, monetizationExperiments, monetizationRevenue } from "../schema/index.js";
import type {
  MonetizationStore,
  PlanRecord,
  ExperimentRecord,
  RevenueRecord,
} from "../../monetization/service.js";
import type { PlanStatus, PriceInterval } from "../../monetization/pricing.js";
import type { RevenueReceipt } from "../../finance/ledger.js";

/**
 * Repository-backed monetization store implementing the injectable {@link MonetizationStore} seam (#188),
 * so `MonetizationService` persists durably in production while unit tests inject in-memory fakes. Reads
 * are **workspace-scoped** (IDOR-safe, #9). Revenue idempotency is the unique
 * `(workspace_id, provider_event_id)` constraint — a replayed webhook upserts nothing new.
 */

function toPlan(row: typeof monetizationPlans.$inferSelect): PlanRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ventureIdeaId: row.ventureIdeaId,
    name: row.name,
    amountCents: row.amountCents,
    currency: row.currency,
    interval: (row.interval as PriceInterval | null) ?? null,
    status: row.status as PlanStatus,
    provider: row.provider,
    productId: row.productId,
    priceId: row.priceId,
    providerLinkId: row.providerLinkId,
    url: row.url,
    activationRequestId: row.activationRequestId,
    previousAmountCents: row.previousAmountCents,
  };
}

function toExperiment(row: typeof monetizationExperiments.$inferSelect): ExperimentRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ventureIdeaId: row.ventureIdeaId,
    planId: row.planId,
    hypothesis: row.hypothesis,
    baselineAmountCents: row.baselineAmountCents,
    candidateAmountCents: row.candidateAmountCents,
    baselineRevenueCents: row.baselineRevenueCents,
    projectedDeltaCents: row.projectedDeltaCents,
    status: row.status as ExperimentRecord["status"],
    activationRequestId: row.activationRequestId,
    verifiedRevenueCents: row.verifiedRevenueCents,
    realizedDeltaCents: row.realizedDeltaCents,
  };
}

function toRevenue(row: typeof monetizationRevenue.$inferSelect): RevenueRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ventureIdeaId: row.ventureIdeaId,
    providerEventId: row.providerEventId,
    amountCents: row.amountCents,
    currency: row.currency,
    occurredAtMs: row.occurredAt.getTime(),
  };
}

export const dbMonetizationStore: MonetizationStore = {
  async createPlan(input): Promise<PlanRecord> {
    const [row] = await db
      .insert(monetizationPlans)
      .values({
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        name: input.name,
        amountCents: input.amountCents,
        currency: input.currency,
        interval: input.interval,
        createdByMemberId: input.createdByMemberId,
      })
      .returning();
    return toPlan(row!);
  },

  async getPlan(workspaceId, id): Promise<PlanRecord | undefined> {
    const [row] = await db
      .select()
      .from(monetizationPlans)
      .where(and(eq(monetizationPlans.workspaceId, workspaceId), eq(monetizationPlans.id, id)))
      .limit(1);
    return row ? toPlan(row) : undefined;
  },

  async listPlans(workspaceId, filter): Promise<PlanRecord[]> {
    const conds = [eq(monetizationPlans.workspaceId, workspaceId)];
    if (filter?.ventureIdeaId === null) conds.push(isNull(monetizationPlans.ventureIdeaId));
    else if (typeof filter?.ventureIdeaId === "string")
      conds.push(eq(monetizationPlans.ventureIdeaId, filter.ventureIdeaId));
    if (filter?.status) conds.push(eq(monetizationPlans.status, filter.status));
    const rows = await db
      .select()
      .from(monetizationPlans)
      .where(and(...conds))
      .orderBy(desc(monetizationPlans.createdAt))
      .limit(filter?.limit ?? 200);
    return rows.map(toPlan);
  },

  async updatePlan(workspaceId, id, patch): Promise<PlanRecord | undefined> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.amountCents !== undefined) set.amountCents = patch.amountCents;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.provider !== undefined) set.provider = patch.provider;
    if (patch.productId !== undefined) set.productId = patch.productId;
    if (patch.priceId !== undefined) set.priceId = patch.priceId;
    if (patch.providerLinkId !== undefined) set.providerLinkId = patch.providerLinkId;
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.activationRequestId !== undefined) set.activationRequestId = patch.activationRequestId;
    if (patch.previousAmountCents !== undefined) set.previousAmountCents = patch.previousAmountCents;
    if (patch.activatedAtMs !== undefined)
      set.activatedAt = patch.activatedAtMs === null ? null : new Date(patch.activatedAtMs);
    const [row] = await db
      .update(monetizationPlans)
      .set(set)
      .where(and(eq(monetizationPlans.workspaceId, workspaceId), eq(monetizationPlans.id, id)))
      .returning();
    return row ? toPlan(row) : undefined;
  },

  async createExperiment(input): Promise<ExperimentRecord> {
    const [row] = await db
      .insert(monetizationExperiments)
      .values({
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        planId: input.planId,
        hypothesis: input.hypothesis,
        baselineAmountCents: input.baselineAmountCents,
        candidateAmountCents: input.candidateAmountCents,
        baselineRevenueCents: input.baselineRevenueCents,
        projectedDeltaCents: input.projectedDeltaCents,
        createdByMemberId: input.createdByMemberId,
      })
      .returning();
    return toExperiment(row!);
  },

  async getExperiment(workspaceId, id): Promise<ExperimentRecord | undefined> {
    const [row] = await db
      .select()
      .from(monetizationExperiments)
      .where(and(eq(monetizationExperiments.workspaceId, workspaceId), eq(monetizationExperiments.id, id)))
      .limit(1);
    return row ? toExperiment(row) : undefined;
  },

  async listExperiments(workspaceId, filter): Promise<ExperimentRecord[]> {
    const conds = [eq(monetizationExperiments.workspaceId, workspaceId)];
    if (filter?.ventureIdeaId === null) conds.push(isNull(monetizationExperiments.ventureIdeaId));
    else if (typeof filter?.ventureIdeaId === "string")
      conds.push(eq(monetizationExperiments.ventureIdeaId, filter.ventureIdeaId));
    const rows = await db
      .select()
      .from(monetizationExperiments)
      .where(and(...conds))
      .orderBy(desc(monetizationExperiments.createdAt))
      .limit(filter?.limit ?? 200);
    return rows.map(toExperiment);
  },

  async updateExperiment(workspaceId, id, patch): Promise<ExperimentRecord | undefined> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.activationRequestId !== undefined) set.activationRequestId = patch.activationRequestId;
    if (patch.verifiedRevenueCents !== undefined) set.verifiedRevenueCents = patch.verifiedRevenueCents;
    if (patch.realizedDeltaCents !== undefined) set.realizedDeltaCents = patch.realizedDeltaCents;
    if (patch.concludedAtMs !== undefined)
      set.concludedAt = patch.concludedAtMs === null ? null : new Date(patch.concludedAtMs);
    const [row] = await db
      .update(monetizationExperiments)
      .set(set)
      .where(and(eq(monetizationExperiments.workspaceId, workspaceId), eq(monetizationExperiments.id, id)))
      .returning();
    return row ? toExperiment(row) : undefined;
  },

  async recordRevenue(input): Promise<{ deduped: boolean; revenue: RevenueRecord }> {
    const existing = await db
      .select()
      .from(monetizationRevenue)
      .where(
        and(
          eq(monetizationRevenue.workspaceId, input.workspaceId),
          eq(monetizationRevenue.providerEventId, input.providerEventId),
        ),
      )
      .limit(1);
    if (existing[0]) return { deduped: true, revenue: toRevenue(existing[0]) };
    const [row] = await db
      .insert(monetizationRevenue)
      .values({
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        provider: "stripe",
        providerEventId: input.providerEventId,
        type: input.type,
        amountCents: input.amountCents,
        currency: input.currency,
        status: input.status,
        raw: input.raw,
        occurredAt: new Date(input.occurredAtMs),
      })
      .returning();
    return { deduped: false, revenue: toRevenue(row!) };
  },

  async sumVentureRevenue(workspaceId, ventureIdeaId, sinceMs): Promise<number> {
    const conds = [
      eq(monetizationRevenue.workspaceId, workspaceId),
      eq(monetizationRevenue.ventureIdeaId, ventureIdeaId),
    ];
    if (sinceMs !== undefined) conds.push(gt(monetizationRevenue.occurredAt, new Date(sinceMs)));
    const [agg] = await db
      .select({ total: sql<number>`COALESCE(SUM(${monetizationRevenue.amountCents}), 0)` })
      .from(monetizationRevenue)
      .where(and(...conds));
    return Number(agg?.total ?? 0);
  },
};

/**
 * Read per-venture verified revenue receipts (#188 AC4) as #194 finance {@link RevenueReceipt}s — the
 * additive source the finance ledger UNIONs alongside `revenue_events` so per-venture revenue lands in the
 * weekly P&L attributed to its venture. Positive-amount rows only (a real payment).
 */
export async function listVentureRevenueReceipts(
  workspaceId: string,
  sinceMs?: number,
): Promise<RevenueReceipt[]> {
  const conds = [eq(monetizationRevenue.workspaceId, workspaceId), gt(monetizationRevenue.amountCents, 0)];
  if (sinceMs !== undefined) conds.push(gt(monetizationRevenue.createdAt, new Date(sinceMs)));
  const rows = await db
    .select({
      providerEventId: monetizationRevenue.providerEventId,
      amountCents: monetizationRevenue.amountCents,
      currency: monetizationRevenue.currency,
      occurredAt: monetizationRevenue.occurredAt,
      ventureIdeaId: monetizationRevenue.ventureIdeaId,
    })
    .from(monetizationRevenue)
    .where(and(...conds))
    .orderBy(desc(monetizationRevenue.occurredAt))
    .limit(1000);
  return rows.map((r) => ({
    providerEventId: r.providerEventId,
    amountCents: r.amountCents,
    currency: r.currency,
    createdAtMs: r.occurredAt.getTime(),
    ventureIdeaId: r.ventureIdeaId,
  }));
}
