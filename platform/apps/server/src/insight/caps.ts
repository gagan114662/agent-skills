import type { InsightConfig } from "../config/schema.js";

/**
 * Resolve the Insight Miner policy from the layered config (#58), applying hard defaults — mirrors
 * `venture/caps.ts resolveVentureCaps`. The miner is **default OFF** (`enabled: false`): a deployment
 * that sets no `insight` section mines nothing and spends nothing.
 */
export interface InsightCaps {
  /** The mining flag. OFF by default. */
  enabled: boolean;
  /** Half-life (days) of the recency decay applied to source/insight freshness. */
  freshnessHalfLifeDays: number;
  /** Estimated cost (cents) charged to tenant usage per mining pass (only bites against a budget). */
  mineCostCents: number;
  /** Hard cap on insights produced in a single mining pass. */
  maxInsightsPerMine: number;
  /** Minimum source evidence strength (0–100) to mine — the "list is the strategy" cut. */
  minSourceStrength: number;
}

export const INSIGHT_DEFAULTS: InsightCaps = {
  enabled: false,
  freshnessHalfLifeDays: 30,
  mineCostCents: 50, // $0.50 estimate per mining pass (only bites against a configured budget)
  maxInsightsPerMine: 10,
  minSourceStrength: 40,
};

export function resolveInsightCaps(cfg: InsightConfig | undefined): InsightCaps {
  return {
    enabled: cfg?.enabled ?? INSIGHT_DEFAULTS.enabled,
    freshnessHalfLifeDays: cfg?.freshnessHalfLifeDays ?? INSIGHT_DEFAULTS.freshnessHalfLifeDays,
    mineCostCents: cfg?.mineCostCents ?? INSIGHT_DEFAULTS.mineCostCents,
    maxInsightsPerMine: cfg?.maxInsightsPerMine ?? INSIGHT_DEFAULTS.maxInsightsPerMine,
    minSourceStrength: cfg?.minSourceStrength ?? INSIGHT_DEFAULTS.minSourceStrength,
  };
}
