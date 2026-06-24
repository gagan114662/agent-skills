/**
 * Finance Ledger IO orchestrator (#194, ADR-0194). Mirrors the #173 service: one injected store/reader
 * seam per source, the pure core (`ledger.ts`) does all the math, and the only writes are the finance
 * layer's OWN bookkeeping (ledger entries + closed books) — never a money movement. `default.ts` wires
 * the real repos; unit tests inject in-memory fakes.
 *
 * The premortem (#200) shapes the seams: `sync` posts ONLY external receipts (Stripe revenue events →
 * verified; the `tenant_usage` window estimate → UNVERIFIED) and is idempotent, so re-running it never
 * double-counts. `close` folds a period's entries into a `finance_close_packs` snapshot whose
 * `verifiedShareBps` tells the owner how much of the books rests on receipts vs. estimates.
 */

import {
  addMonths,
  composeClosePack,
  postingFromRevenueEvent,
  postingFromUsageWindow,
  periodKeyOf,
  recentPeriodKeys,
  runwayForecast,
  type ClosePack,
  type LedgerEntry,
  type LedgerPosting,
  type RevenueReceipt,
  type RunwayForecast,
} from "./ledger.js";
import { ledgerEntriesToCsv, closePacksToCsv } from "./export.js";
import type { FinanceCaps } from "./caps.js";

// ---- store + reader seams ----------------------------------------------------------------------

/** A persisted close pack (a `ClosePack` plus its row id + close time). */
export interface StoredClosePack extends ClosePack {
  id: string;
  closedAtMs: number;
}

/** Filter for a ledger read. `ventureIdeaId: null` selects workspace-level (unattributed) entries. */
export interface LedgerFilter {
  ventureIdeaId?: string | null;
  /** Restrict to the entries whose `occurredAt` falls in this `YYYY-MM` period. */
  periodKey?: string;
  limit?: number;
}

/** Filter for a close-pack read. `ventureIdeaId: null` selects workspace-level closed books. */
export interface ClosePackFilter {
  periodKey?: string;
  periodKeys?: string[];
  ventureIdeaId?: string | null;
  limit?: number;
}

/** The durable store seam — the repository implements this; tests inject an in-memory version. */
export interface FinanceStore {
  /** Idempotent upsert of a posting on `(workspaceId, source, sourceRef)`. Returns the stored entry. */
  postEntry(posting: LedgerPosting): Promise<LedgerEntry>;
  /** Workspace-scoped ledger read (IDOR-safe). `periodKey` restricts by `occurredAt`. */
  listEntries(workspaceId: string, filter?: LedgerFilter): Promise<LedgerEntry[]>;
  /** Idempotent upsert of a close pack on `(workspaceId, ventureIdeaId, periodKey)`. */
  upsertClosePack(pack: ClosePack): Promise<StoredClosePack>;
  /** Workspace-scoped close-pack read, newest period first. */
  listClosePacks(workspaceId: string, filter?: ClosePackFilter): Promise<StoredClosePack[]>;
  /** Workspace-scoped aggregate over close-pack net values; avoids materializing historical packs. */
  sumClosePackNet(workspaceId: string, filter?: { ventureIdeaId?: string | null }): Promise<number>;
}

/** Verified inbound revenue receipts (#98 `revenue_events`). `sinceMs` is an optional incremental cursor. */
export interface RevenueEventReader {
  listReceipts(workspaceId: string, sinceMs?: number): Promise<RevenueReceipt[]>;
}

/** The current `tenant_usage` window's estimated model spend (#71). */
export interface UsageCostReader {
  window(now: Date): string;
  estimatedCostCents(workspaceId: string, window: string): Promise<number>;
}

/** Maps a revenue receipt to a venture, or null for a workspace-level entry. Default: always null. */
export type VentureAttributor = (workspaceId: string, receipt: RevenueReceipt) => string | null;

export interface FinanceServiceDeps {
  store: FinanceStore;
  revenue: RevenueEventReader;
  usage: UsageCostReader;
  caps: (workspaceId: string) => FinanceCaps;
  currency: (workspaceId: string) => string;
  /** Optional venture attribution (v1 default: workspace-level). */
  attribute?: VentureAttributor;
  now?: () => Date;
}

// ---- result shapes -----------------------------------------------------------------------------

export interface SyncResult {
  workspaceId: string;
  periodKey: string;
  revenuePosted: number;
  costPosted: number;
}

/** The per-venture finance section attached to the #173 weekly report. */
export interface WeeklyFinanceSection {
  workspaceId: string;
  periodKey: string;
  currency: string;
  /** The workspace-level close for the current period (the company's books). */
  workspace: ClosePack;
  /** Per-venture closes for the current period (only ventures with attributed entries). */
  ventures: ClosePack[];
  runway: RunwayForecast;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export class FinanceService {
  constructor(private readonly deps: FinanceServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Post every NEW external receipt for `workspaceId` into the ledger (idempotent). Revenue events →
   * verified credits; the current usage window's estimate → one UNVERIFIED debit (upserted as it
   * accrues). Returns how many of each were posted. No-op semantics: re-running posts nothing new.
   */
  async sync(workspaceId: string): Promise<SyncResult> {
    const now = this.now();
    const periodKey = periodKeyOf(now.getTime());
    const attribute = this.deps.attribute;

    const receipts = await this.deps.revenue.listReceipts(workspaceId);
    let revenuePosted = 0;
    for (const r of receipts) {
      const ventureIdeaId = attribute ? attribute(workspaceId, r) : (r.ventureIdeaId ?? null);
      await this.deps.store.postEntry({ ...postingFromRevenueEvent(workspaceId, r), ventureIdeaId });
      revenuePosted += 1;
    }

    const window = this.deps.usage.window(now);
    const estimated = await this.deps.usage.estimatedCostCents(workspaceId, window);
    let costPosted = 0;
    if (estimated > 0) {
      const occurredAtMs = Date.parse(`${window}-15T00:00:00Z`); // anchor mid-window for period bucketing
      await this.deps.store.postEntry(
        postingFromUsageWindow(workspaceId, window, estimated, occurredAtMs, this.deps.currency(workspaceId)),
      );
      costPosted = 1;
    }

    return { workspaceId, periodKey, revenuePosted, costPosted };
  }

  /**
   * Close the books for `periodKey` (defaults to the current period): compute + upsert the workspace-level
   * pack (all period entries) plus one pack per distinct venture with attributed entries. Idempotent —
   * re-closing refreshes the same rows. Returns the closed packs (workspace-level first).
   */
  async close(workspaceId: string, periodKey?: string): Promise<StoredClosePack[]> {
    const period = periodKey ?? periodKeyOf(this.now().getTime());
    const currency = this.deps.currency(workspaceId);
    const entries = await this.deps.store.listEntries(workspaceId, { periodKey: period });

    const out: StoredClosePack[] = [];
    // Workspace-level book: every entry in the period.
    out.push(
      await this.deps.store.upsertClosePack(
        composeClosePack({ workspaceId, ventureIdeaId: null, periodKey: period, currency, entries }),
      ),
    );
    // Per-venture books: one per distinct attributed venture.
    const ventureIds = [...new Set(entries.map((e) => e.ventureIdeaId).filter((v): v is string => v !== null))];
    for (const ventureIdeaId of ventureIds) {
      out.push(
        await this.deps.store.upsertClosePack(
          composeClosePack({
            workspaceId,
            ventureIdeaId,
            periodKey: period,
            currency,
            entries: entries.filter((e) => e.ventureIdeaId === ventureIdeaId),
          }),
        ),
      );
    }
    return out;
  }

  /** Read the ledger (workspace-scoped). */
  async ledger(workspaceId: string, filter?: LedgerFilter): Promise<LedgerEntry[]> {
    const limit = filter?.limit ?? this.deps.caps(workspaceId).ledgerLimit;
    return this.deps.store.listEntries(workspaceId, { ...filter, limit });
  }

  /** Read the closed books (workspace-scoped). */
  async closePacks(
    workspaceId: string,
    filter?: ClosePackFilter,
  ): Promise<StoredClosePack[]> {
    return this.deps.store.listClosePacks(workspaceId, filter);
  }

  /**
   * The runway forecast from the workspace-level closed books. Cash position = Σ net across closed
   * periods; the burn basis = the recent `lookbackMonths` periods. Pure math (`runwayForecast`) over
   * what the books say — the on-track/at-risk header is real, not a guess.
   */
  async runway(workspaceId: string): Promise<RunwayForecast> {
    const caps = this.deps.caps(workspaceId);
    const currency = this.deps.currency(workspaceId);
    const currentPeriodKey = periodKeyOf(this.now().getTime());
    const burnPeriodKeys = recentPeriodKeys(addMonths(currentPeriodKey, -1), caps.lookbackMonths);
    const [cashPositionCents, packs] = await Promise.all([
      this.deps.store.sumClosePackNet(workspaceId, { ventureIdeaId: null }),
      this.deps.store.listClosePacks(workspaceId, {
        ventureIdeaId: null,
        periodKeys: burnPeriodKeys,
        limit: burnPeriodKeys.length,
      }),
    ]);
    const byPeriod = new Map(packs.map((p) => [p.periodKey, p]));
    // Burn basis = the COMPLETED periods (anchor at the previous month) — the partial current month
    // would understate burn and make runway look longer than it is (optimistic, the wrong direction).
    const incompletePeriodKeys: string[] = [];
    const periods: Array<{ periodKey: string; netCents: number; verifiedNetCents: number }> = [];
    for (const periodKey of burnPeriodKeys) {
      const p = byPeriod.get(periodKey);
      if (!p) {
        incompletePeriodKeys.push(periodKey);
        continue;
      }
      periods.push({
        periodKey,
        netCents: p.netCents,
        verifiedNetCents: p.verifiedRevenueCents - p.verifiedCostCents,
      });
    }
    return runwayForecast(
      {
        workspaceId,
        currency,
        cashPositionCents,
        periods,
        lookbackPeriodCount: burnPeriodKeys.length,
        incompletePeriodKeys,
        currentPeriodKey,
        floorCents: caps.floorCents,
      },
      caps.atRiskMonths,
    );
  }

  /** The finance section attached to the #173 weekly report — current-period closes + runway. */
  async weeklyFinanceSection(workspaceId: string): Promise<WeeklyFinanceSection> {
    const periodKey = periodKeyOf(this.now().getTime());
    const currency = this.deps.currency(workspaceId);
    const entries = await this.deps.store.listEntries(workspaceId, { periodKey });
    const workspace = composeClosePack({ workspaceId, ventureIdeaId: null, periodKey, currency, entries });
    const ventureIds = [...new Set(entries.map((e) => e.ventureIdeaId).filter((v): v is string => v !== null))];
    const ventures = ventureIds.map((ventureIdeaId) =>
      composeClosePack({
        workspaceId,
        ventureIdeaId,
        periodKey,
        currency,
        entries: entries.filter((e) => e.ventureIdeaId === ventureIdeaId),
      }),
    );
    const runway = await this.runway(workspaceId);
    return { workspaceId, periodKey, currency, workspace, ventures, runway };
  }

  /** CSV period statement of ledger entries for the accountant (optionally one period). */
  async exportLedgerCsv(workspaceId: string, periodKey?: string): Promise<string> {
    const entries = await this.ledger(workspaceId, periodKey ? { periodKey } : undefined);
    return ledgerEntriesToCsv(entries);
  }

  /** CSV statement of closed books for the accountant. */
  async exportCloseCsv(workspaceId: string, periodKey?: string): Promise<string> {
    const packs = await this.closePacks(workspaceId, periodKey ? { periodKey } : undefined);
    return closePacksToCsv(packs);
  }
}

/** The sentinel uuid the close-pack unique index folds a NULL venture onto (workspace-level book). */
export const WORKSPACE_SCOPE_UUID = ZERO_UUID;
