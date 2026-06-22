/**
 * Multi-touch revenue attribution + the daily revenue/pipeline/spend dashboard (#614, #615) — module barrel.
 *
 * The shape of the fix in code, end to end:
 *
 *   1. Tie a paying customer to their full chain:   const j = await svc.customerJourney(ws, ref);   // #614
 *        → j.touches (agent + channel, ordered) and j.credits (multi-touch revenue split).
 *   2. Rank what drove revenue:                       buildJourneys(touches, payments) → rollupByChannel/Agent
 *   3. Glance at the money:                            const d = await svc.dashboard(ws);             // #615
 *        → d.totals (revenue, paying customers, pipeline, spend, net) + d.trend + d.byChannel/byAgent.
 *
 * Self-contained and migration-free: it READS the #386 exposures, #98 receipts, #667 cost rollup, and #98
 * payment links — no new table, no schema barrel, no app-wiring change. The read endpoints attach to the
 * already-registered `/me/analytics/*` routes. Same conflict-free shape as #667 cost + #611 lead-scoring.
 */

export * from "./types.js";
export {
  weightsFor,
  distributeCents,
  buildJourney,
  buildJourneys,
  rollupByChannel,
  rollupByAgent,
  type BuildJourneysOptions,
} from "./attribution.js";
export {
  buildDashboard,
  dayKeyUtc,
  MICROS_PER_CENT,
  type DailySpend,
  type BuildDashboardInput,
  type BuildDashboardOptions,
} from "./dashboard.js";
export {
  RevenueAnalyticsService,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_MAX_CHAIN_AGE_MS,
  type RevenueAnalyticsDeps,
  type JourneyQuery,
  type DashboardQuery,
} from "./service.js";
export type { TouchReader, RevenueReader, SpendReader, PipelineReader } from "./store.js";
export { createDefaultRevenueAnalyticsService } from "./default.js";
