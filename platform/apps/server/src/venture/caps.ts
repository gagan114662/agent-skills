import type { VentureConfig } from "../config/schema.js";
import type { VentureThresholds } from "./types.js";

/**
 * Resolve the venture policy from the layered config (#58), applying hard defaults — mirrors
 * `scale/caps.ts resolveScaleCaps`. The gate is **default OFF** (`enabled: false`): a deployment that
 * sets no `venture` section keeps today's behavior (autonomy launches are never blocked).
 */
export interface VentureCaps {
  /** The anti-demo gate flag. OFF by default. */
  enabled: boolean;
  fund: number;
  kill: number;
  escalateBand: number;
  maxIterations: number;
  /** Weight on the adversarial Reviewer when combining the two personas (0–1). */
  reviewerWeight: number;
  /** How long a passing scorecard stays valid for the admission gate. */
  scorecardTtlMinutes: number;
  /** Estimated cost (cents) charged to tenant usage per scoring pass. */
  evaluationCostCents: number;
}

export const VENTURE_DEFAULTS: VentureCaps = {
  enabled: false,
  fund: 70,
  kill: 35,
  escalateBand: 10,
  maxIterations: 3,
  reviewerWeight: 0.6,
  scorecardTtlMinutes: 7 * 24 * 60, // 7 days
  evaluationCostCents: 100, // $1 estimate per scoring pass (only bites against a configured budget)
};

export function resolveVentureCaps(cfg: VentureConfig | undefined): VentureCaps {
  return {
    enabled: cfg?.enabled ?? VENTURE_DEFAULTS.enabled,
    fund: cfg?.fundThreshold ?? VENTURE_DEFAULTS.fund,
    kill: cfg?.killThreshold ?? VENTURE_DEFAULTS.kill,
    escalateBand: cfg?.escalateBand ?? VENTURE_DEFAULTS.escalateBand,
    maxIterations: cfg?.maxIterations ?? VENTURE_DEFAULTS.maxIterations,
    reviewerWeight: cfg?.reviewerWeight ?? VENTURE_DEFAULTS.reviewerWeight,
    scorecardTtlMinutes: cfg?.scorecardTtlMinutes ?? VENTURE_DEFAULTS.scorecardTtlMinutes,
    evaluationCostCents: cfg?.evaluationCostCents ?? VENTURE_DEFAULTS.evaluationCostCents,
  };
}

/** Project the decision thresholds out of the resolved caps. */
export function ventureThresholds(caps: VentureCaps): VentureThresholds {
  return {
    fund: caps.fund,
    kill: caps.kill,
    escalateBand: caps.escalateBand,
    maxIterations: caps.maxIterations,
  };
}
