/**
 * The reader seams for the multi-touch attribution + dashboard module (#614, #615).
 *
 * The service orchestrates over these four read-only seams; it NEVER writes. Tests inject in-memory fakes
 * (no DB); `default.ts` binds the real, already-existing sources — the #386 exposure repo, the #98 revenue
 * receipts, the #667 cost rollup, the #98 payment links. Keeping the seams here (not the pure types file)
 * mirrors the #667 cost module split: pure math + types in their own files, IO contracts in this one.
 *
 * Every method is workspace-scoped (#3 IDOR discipline): a reader only ever sees one tenant's rows.
 */

import type { DailySpend } from "./dashboard.js";
import type { Payment, PipelineEntry, Touch } from "./types.js";

/** Lists the influence touches (agent action on a channel) for a workspace, optionally since a cursor. */
export interface TouchReader {
  /** Touches at-or-after `sinceMs` (or all, when omitted). The journey builder filters happened-before. */
  listTouches(workspaceId: string, sinceMs?: number): Promise<Touch[]>;
}

/** Lists verified inbound payment receipts for a workspace. Mirrors the finance/#386 RevenueEventReader. */
export interface RevenueReader {
  listPayments(workspaceId: string, sinceMs?: number): Promise<Payment[]>;
}

/** Per-day operating spend (micro-dollars) for a workspace — the #667 cost rollup. Optional source. */
export interface SpendReader {
  dailySpendMicros(workspaceId: string, sinceMs?: number): Promise<DailySpend[]>;
}

/** Open pipeline items (potential revenue in flight) for a workspace — the #98 payment links. Optional. */
export interface PipelineReader {
  listOpen(workspaceId: string): Promise<PipelineEntry[]>;
}
