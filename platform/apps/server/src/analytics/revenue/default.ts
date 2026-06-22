/**
 * Bind the {@link RevenueAnalyticsService} seams to the real, already-existing sources (#614, #615).
 * Read-only and migration-free — it reuses what other modules already persist; it adds no table:
 *
 *  - touches  ← the #386 attribution EXPOSURES (`attribution_exposures`): each exposure is one influence
 *               touch (artifact shown on a channel under a tracking ref). The tracking ref is the customer
 *               join key. Exposures carry no driving agent, so `agent` is honestly `none` until a richer
 *               touch source lands — the seam is identical, so multi-touch lights up with zero core changes.
 *  - revenue  ← the #98 verified `revenue_events` (via the shared finance `dbRevenueReader`). A receipt with
 *               a tracking ref joins its customer's journey; a no-ref receipt still counts as revenue under a
 *               synthetic per-payment key (a distinct, honestly-unattributed paying customer).
 *  - spend    ← the #667 per-day cost rollup (`createDefaultCostService().getSummary`). The system's
 *               operating spend, in micro-dollars.
 *  - pipeline ← the #98 `payment_links` minted for the workspace: offers on the table (potential revenue).
 *
 * Nothing here is money or egress: every seam is a workspace-scoped READ (#3).
 */

import { and, eq, gt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { paymentLinks } from "../../db/schema/index.js";
import { dbAttributionExposureStore } from "../../db/repositories/attribution.js";
import { dbRevenueReader } from "../../finance/default.js";
import { createDefaultCostService } from "../../observability/cost/default.js";
import { loadConfig } from "../../config/loader.js";
import { RevenueAnalyticsService } from "./service.js";
import type { PipelineReader, RevenueReader, SpendReader, TouchReader } from "./store.js";
import { UNATTRIBUTED_AGENT, UNATTRIBUTED_CHANNEL } from "./types.js";

/** Touches from the #386 exposure ledger: one touch per exposure, joined to a customer by its tracking ref. */
const dbTouchReader: TouchReader = {
  async listTouches(workspaceId, sinceMs) {
    const exposures = await dbAttributionExposureStore.listExposures(workspaceId, sinceMs);
    return exposures.map((e) => ({
      customerRef: e.trackingRef,
      channel: e.channel || UNATTRIBUTED_CHANNEL,
      // Exposures carry no driving agent (#386); honest `none` until a richer touch source is wired.
      agent: UNATTRIBUTED_AGENT,
      kind: e.artifactKind,
      artifactId: e.artifactId,
      occurredAtMs: e.occurredAtMs,
    }));
  },
};

/** Payments from the #98 verified revenue receipts. No-ref receipts get a synthetic distinct customer key. */
const dbRevenueAnalyticsReader: RevenueReader = {
  async listPayments(workspaceId, sinceMs) {
    const receipts = await dbRevenueReader.listReceipts(workspaceId, sinceMs);
    return receipts.map((r) => ({
      // A ref-carrying receipt joins its journey; a no-ref payment is still a paying customer, kept distinct
      // by its provider event id so it counts once and stays honestly unattributed (empty touch chain).
      customerRef: r.trackingRef ?? `pe:${r.providerEventId}`,
      providerEventId: r.providerEventId,
      amountCents: r.amountCents,
      currency: r.currency,
      paidAtMs: r.createdAtMs,
    }));
  },
};

/** Per-day operating spend from the #667 cost rollup, in micro-dollars. */
const dbSpendReader: SpendReader = {
  async dailySpendMicros(workspaceId, sinceMs) {
    const cost = createDefaultCostService();
    const summary = await cost.getSummary(workspaceId, {
      since: sinceMs !== undefined ? new Date(sinceMs) : undefined,
    });
    return summary.byDay.map((d) => ({ date: d.date, micros: d.costMicros }));
  },
};

/** Open pipeline = the #98 payment links minted for the workspace (offers on the table). */
const dbPipelineReader: PipelineReader = {
  async listOpen(workspaceId) {
    const rows = await db
      .select({
        id: paymentLinks.id,
        productId: paymentLinks.productId,
        amountCents: paymentLinks.amountCents,
        currency: paymentLinks.currency,
        createdAt: paymentLinks.createdAt,
      })
      .from(paymentLinks)
      .where(and(eq(paymentLinks.workspaceId, workspaceId), gt(paymentLinks.amountCents, 0)))
      .limit(500);
    return rows.map((r) => ({
      ref: r.id,
      label: r.productId,
      channel: UNATTRIBUTED_CHANNEL,
      agent: UNATTRIBUTED_AGENT,
      estValueCents: r.amountCents,
      currency: r.currency,
      stage: "link_minted",
      updatedAtMs: r.createdAt.getTime(),
    }));
  },
};

const currencyOf = (workspaceId: string): string => loadConfig(workspaceId).billing?.currency ?? "usd";

/** The process-default service bound to the real repos. Routes use this; tests inject their own deps. */
export function createDefaultRevenueAnalyticsService(): RevenueAnalyticsService {
  return new RevenueAnalyticsService({
    touches: dbTouchReader,
    revenue: dbRevenueAnalyticsReader,
    spend: dbSpendReader,
    pipeline: dbPipelineReader,
    currency: currencyOf,
    now: () => Date.now(),
  });
}
