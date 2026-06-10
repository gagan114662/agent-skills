import type { GatePricingConfig } from "../config/schema.js";
import type { PricingThresholds } from "./pricing.js";

/**
 * Resolve the gate-pricing policy from the layered config (#58), applying hard defaults — mirrors
 * `venture/caps.ts` and `watchdog/caps.ts`. The pricer is **default OFF** (`enabled: false`): a
 * deployment that sets no `gatePricing` section keeps today's static gates (no auto-relax / re-tighten),
 * and the background tick is also default-off (`GATE_PRICING_INTERVAL_MS = 0`).
 */
export interface GatePricingCaps {
  /** The auto-relax/re-tighten pricer flag. OFF by default. */
  enabled: boolean;
  /** Trailing-window size: how many recent decisions per action class the pricer measures. */
  windowSize: number;
  /** Minimum decisions before a strict boundary may relax (the insufficient-evidence guard). */
  minSamples: number;
  /** Error rate strictly below which a strict boundary RELAXes. */
  relaxBelowRate: number;
  /** Error rate strictly above which a relaxed boundary RE-TIGHTENs. Must be > `relaxBelowRate`. */
  retightenAboveRate: number;
}

export const GATE_PRICING_DEFAULTS: GatePricingCaps = {
  enabled: false,
  windowSize: 100,
  minSamples: 100,
  relaxBelowRate: 0.05, // <5% correction rate over the window → earn auto-approve
  retightenAboveRate: 0.15, // >15% correction rate on a relaxed class → climb back to a human
};

export function resolveGatePricingCaps(cfg: GatePricingConfig | undefined): GatePricingCaps {
  const relaxBelowRate = cfg?.relaxBelowRate ?? GATE_PRICING_DEFAULTS.relaxBelowRate;
  let retightenAboveRate = cfg?.retightenAboveRate ?? GATE_PRICING_DEFAULTS.retightenAboveRate;
  // Hysteresis is structural: the re-tighten rail must sit strictly above the relax rail, else the
  // boundary could flap. A misconfigured layer is clamped up to the relax rail rather than trusted.
  if (retightenAboveRate <= relaxBelowRate) retightenAboveRate = relaxBelowRate;
  return {
    enabled: cfg?.enabled ?? GATE_PRICING_DEFAULTS.enabled,
    windowSize: cfg?.windowSize ?? GATE_PRICING_DEFAULTS.windowSize,
    minSamples: cfg?.minSamples ?? GATE_PRICING_DEFAULTS.minSamples,
    relaxBelowRate,
    retightenAboveRate,
  };
}

/** Project the pure decision thresholds out of the resolved caps. */
export function gatePricingThresholds(caps: GatePricingCaps): PricingThresholds {
  return {
    minSamples: caps.minSamples,
    relaxBelowRate: caps.relaxBelowRate,
    retightenAboveRate: caps.retightenAboveRate,
  };
}
