import type { PortfolioConfig } from "../config/schema.js";
import type { PortfolioThresholds } from "./types.js";

/**
 * Resolve the portfolio-loop policy from the layered config (#58), applying hard defaults — mirrors
 * `moat/caps.ts` / `growth/caps.ts`. The loop is **default OFF** (`enabled: false`): a deployment that
 * sets no `portfolio` block keeps today's behavior — reviews still compute/persist on demand (harmless,
 * tenant-scoped) but the Founder Console raises no attention and no proactive tick runs. SUNSET
 * execution stays #13-gated regardless of this flag (kill discipline is never opt-out by `enabled`).
 *
 * The threshold/weight fields ARE the per-venture "targets" the review judges against (the tenant's
 * layered, lockable policy — #96 stores no FUND-time target; see ADR-0107).
 */
export interface PortfolioCaps extends PortfolioThresholds {
  /** The portfolio-loop flag. OFF by default. */
  enabled: boolean;
}

export const PORTFOLIO_DEFAULTS: PortfolioCaps = {
  enabled: false,
  doubleDownScore: 70,
  sunsetScore: 25,
  minReviewAgeDays: 14,
  demandSignalPoints: 20,
  weightGrowth: 0.4,
  weightMoat: 0.35,
  weightDemand: 0.25,
};

export function resolvePortfolioCaps(cfg: PortfolioConfig | undefined): PortfolioCaps {
  return {
    enabled: cfg?.enabled ?? PORTFOLIO_DEFAULTS.enabled,
    doubleDownScore: cfg?.doubleDownScore ?? PORTFOLIO_DEFAULTS.doubleDownScore,
    sunsetScore: cfg?.sunsetScore ?? PORTFOLIO_DEFAULTS.sunsetScore,
    minReviewAgeDays: cfg?.minReviewAgeDays ?? PORTFOLIO_DEFAULTS.minReviewAgeDays,
    demandSignalPoints: cfg?.demandSignalPoints ?? PORTFOLIO_DEFAULTS.demandSignalPoints,
    weightGrowth: cfg?.weightGrowth ?? PORTFOLIO_DEFAULTS.weightGrowth,
    weightMoat: cfg?.weightMoat ?? PORTFOLIO_DEFAULTS.weightMoat,
    weightDemand: cfg?.weightDemand ?? PORTFOLIO_DEFAULTS.weightDemand,
  };
}
