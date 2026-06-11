import type { ConstitutionConfig } from "../config/schema.js";

/**
 * Resolve the constitution policy from the layered config (#58), applying hard defaults — mirrors
 * `venture/caps.ts resolveVentureCaps`. The whole apparatus is **default OFF** (`enabled: false`): a
 * deployment that sets no `constitution` section keeps today's behavior (no decision is ever scored or
 * gated).
 */

/** The 10/5/20 pricing-ladder knobs (Article VIII). */
export interface PricingLadderCaps {
  /** Coarse increment (%) proposed when deal-loss is comfortably low. */
  coarseStepPct: number;
  /** Fine increment (%) proposed as deal-loss approaches the ceiling. */
  fineStepPct: number;
  /** Deal-loss (%) at/above which the ladder holds and FLAGS (the ceiling is found). */
  dealLossCeilingPct: number;
}

export interface ConstitutionCaps {
  /** Master flag — OFF by default. */
  enabled: boolean;
  /** Article I: minimum distinct unaffiliated paying-intent signals a B2B venture needs to FUND. */
  loveMinSignals: number;
  /** Article VIII pricing-ladder knobs. */
  pricing: PricingLadderCaps;
}

export const CONSTITUTION_DEFAULTS: ConstitutionCaps = {
  enabled: false,
  loveMinSignals: 10,
  pricing: {
    coarseStepPct: 10,
    fineStepPct: 5,
    dealLossCeilingPct: 20,
  },
};

export function resolveConstitutionCaps(cfg: ConstitutionConfig | undefined): ConstitutionCaps {
  return {
    enabled: cfg?.enabled ?? CONSTITUTION_DEFAULTS.enabled,
    loveMinSignals: cfg?.loveMinSignals ?? CONSTITUTION_DEFAULTS.loveMinSignals,
    pricing: {
      coarseStepPct: cfg?.pricingCoarseStepPct ?? CONSTITUTION_DEFAULTS.pricing.coarseStepPct,
      fineStepPct: cfg?.pricingFineStepPct ?? CONSTITUTION_DEFAULTS.pricing.fineStepPct,
      dealLossCeilingPct:
        cfg?.pricingDealLossCeilingPct ?? CONSTITUTION_DEFAULTS.pricing.dealLossCeilingPct,
    },
  };
}
