/**
 * Per-run cost + token observability (issue #667).
 *
 * Estimates token cost from the model id + the token counts the #560 trace already captures, and rolls runs
 * up per agent and per UTC day. Self-contained and migration-free: it reads the existing trace tables and
 * carries its own static pricing (env-overridable). The read surface is wired into the traces routes.
 */

export {
  estimateCostMicros,
  resolveModelPricing,
  normalizeModelId,
  formatUsd,
  DEFAULT_PRICING,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  type ModelPricing,
  type CostUsage,
  type PricingMatch,
} from "./pricing.js";

export {
  enrichRunCost,
  summarizeRuns,
  rollupByAgent,
  rollupByDay,
  breakdownByModel,
  summarizeRunCost,
  dayKeyUtc,
  type RunCostRow,
  type RunCostEventRow,
  type EnrichedRunCost,
  type CostTotals,
  type AgentCostRollup,
  type DailyCostRollup,
  type ModelCostLine,
  type RunCostSummary,
} from "./rollup.js";

export {
  CostObservabilityService,
  resolveFallbackModel,
  type CostDeps,
  type CostWindow,
  type CostSummary,
} from "./service.js";

export { createDefaultCostService } from "./default.js";
