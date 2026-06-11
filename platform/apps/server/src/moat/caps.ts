import type { MoatConfig } from "../config/schema.js";
import { defaultMoatWeights, type MoatWeights } from "./score.js";

/**
 * Resolve the moat policy from the layered config (#58), applying hard defaults — mirrors
 * `resolveVentureCaps`. **Default OFF** (`enabled: false`): a deployment that sets no `moat` section
 * still scores/records moat on demand but flags nothing in the Founder Console.
 */
export interface MoatCaps {
  /** The Founder Console stagnation-flagging flag. OFF by default. */
  enabled: boolean;
  /** Trailing window (days) a venture with zero accrual is flagged stagnant over. */
  stagnationWindowDays: number;
  /** Per-dimension aggregate weights (equal by default). */
  weights: MoatWeights;
}

export const MOAT_DEFAULTS: MoatCaps = {
  enabled: false,
  stagnationWindowDays: 30,
  weights: defaultMoatWeights(),
};

export function resolveMoatCaps(cfg: MoatConfig | undefined): MoatCaps {
  const w = defaultMoatWeights();
  return {
    enabled: cfg?.enabled ?? MOAT_DEFAULTS.enabled,
    stagnationWindowDays: cfg?.stagnationWindowDays ?? MOAT_DEFAULTS.stagnationWindowDays,
    weights: {
      proprietaryData: cfg?.weightProprietaryData ?? w.proprietaryData,
      switchingCosts: cfg?.weightSwitchingCosts ?? w.switchingCosts,
      distributionLockIn: cfg?.weightDistributionLockIn ?? w.distributionLockIn,
      accumulatedEvals: cfg?.weightAccumulatedEvals ?? w.accumulatedEvals,
    },
  };
}

/** Project the per-dimension weights out of the resolved caps. */
export function moatWeights(caps: MoatCaps): MoatWeights {
  return caps.weights;
}

/** The stagnation window in milliseconds. */
export function stagnationWindowMs(caps: MoatCaps): number {
  return caps.stagnationWindowDays * 24 * 60 * 60 * 1000;
}
