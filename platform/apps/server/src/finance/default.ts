import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { revenueEvents } from "../db/schema/index.js";
import { dbFinanceStore } from "../db/repositories/finance.js";
import { listVentureRevenueReceipts } from "../db/repositories/monetization.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { listWorkspaceIds } from "../db/repositories/workspaces.js";
import { windowKey } from "../scale/usage.js";
import { loadConfig } from "../config/loader.js";
import { getMaintenanceState } from "../maintenance/flag.js";
import type { SessionLogger } from "../runtime/manager.js";
import type { RevenueReceipt } from "./ledger.js";
import { resolveFinanceCaps } from "./caps.js";
import { FinanceService, type RevenueEventReader } from "./service.js";
import { FinanceLedgerEngine } from "./engine.js";

/**
 * Wire the Finance Ledger over the real repos (#194, ADR-0194). Mirrors `createDefaultFounderBriefingsService`:
 * one reader/store seam per source, defaults filled by `resolveFinanceCaps`, currency from the #98 billing
 * config. The revenue reader lists verified inbound payment receipts (`revenue_events` with a positive
 * amount) — the only externally-receipted revenue source; the cost reader is the #71 `tenant_usage`
 * estimate (posted UNVERIFIED). NO outbound money provider is wired anywhere here.
 */

/**
 * Read verified inbound payment receipts (positive-amount events only). Two externally-receipted sources,
 * UNIONed: the workspace-level #98 `revenue_events` (ipop's own billing → unattributed), and the #188
 * per-venture `monetization_revenue` (each row carries its `ventureIdeaId`, so it lands on that venture's
 * P&L). The two are disjoint — a venture charges through its OWN Stripe account, never ipop's — so there
 * is no double count. With monetization OFF the venture source is simply empty (unchanged behavior).
 */
export const dbRevenueReader: RevenueEventReader = {
  async listReceipts(workspaceId: string, sinceMs?: number): Promise<RevenueReceipt[]> {
    const conds = [eq(revenueEvents.workspaceId, workspaceId), gt(revenueEvents.amountCents, 0)];
    if (sinceMs !== undefined) conds.push(gt(revenueEvents.createdAt, new Date(sinceMs)));
    const rows = await db
      .select({
        providerEventId: revenueEvents.providerEventId,
        amountCents: revenueEvents.amountCents,
        currency: revenueEvents.currency,
        createdAt: revenueEvents.createdAt,
      })
      .from(revenueEvents)
      .where(and(...conds))
      .orderBy(desc(revenueEvents.createdAt))
      .limit(1000);
    const workspaceReceipts: RevenueReceipt[] = rows.map((r) => ({
      providerEventId: r.providerEventId,
      amountCents: r.amountCents,
      currency: r.currency,
      createdAtMs: r.createdAt.getTime(),
      // ipop's own billing is workspace-level (unattributed).
      ventureIdeaId: null,
    }));
    // #188 per-venture revenue, attributed to its venture (so it shows on the per-venture weekly P&L).
    const ventureReceipts = await listVentureRevenueReceipts(workspaceId, sinceMs);
    return [...workspaceReceipts, ...ventureReceipts];
  },
};

const currencyOf = (workspaceId: string): string =>
  loadConfig(workspaceId).billing?.currency ?? "usd";

export function createDefaultFinanceService(): FinanceService {
  return new FinanceService({
    store: dbFinanceStore,
    revenue: dbRevenueReader,
    usage: {
      window: (now) => windowKey(now),
      estimatedCostCents: async (workspaceId, window) => (await getUsage(workspaceId, window)).estimatedCostCents,
    },
    caps: (workspaceId) => resolveFinanceCaps(loadConfig(workspaceId).finance),
    currency: currencyOf,
  });
}

export function createDefaultFinanceEngine(logger: SessionLogger, service: FinanceService): FinanceLedgerEngine {
  return new FinanceLedgerEngine({
    service,
    listWorkspaceIds,
    caps: (workspaceId) => resolveFinanceCaps(loadConfig(workspaceId).finance),
    maintenancePaused: async () => (await getMaintenanceState()).enabled,
    logger,
  });
}
