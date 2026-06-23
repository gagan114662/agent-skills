import type { GrowthConfig } from "../config/schema.js";

/**
 * Resolve the growth-loop policy from the layered config (#58), applying hard defaults — mirrors
 * `venture/caps.ts` / `flywheel/caps.ts`. The growth loop is **default OFF** (`enabled: false`): a
 * deployment that sets no `growth` section surfaces a zeroed pane and proposes nothing proactively.
 *
 * Event *ingest* via the API is always available (recording a growth event is harmless and
 * tenant-scoped) — `enabled` gates the proactive growth posture, the same way #119 keeps evidence
 * recording always-on while gating the auto-relax behaviour.
 */
export interface GrowthCaps {
  /** The growth-loop flag. OFF by default. */
  enabled: boolean;
  /** Acquisition count below which the score is forced to 0 (not enough signal to be meaningful). */
  minTrafficForScore: number;
  /** Acquisition sample required before a campaign/content experiment can be auto-paused. */
  autoPauseMinAcquisitions: number;
  /** Conversion-rate ceiling below which a sampled campaign/content experiment is paused. */
  autoPauseMaxConversionRate: number;
}

export const GROWTH_DEFAULTS: GrowthCaps = {
  enabled: false,
  minTrafficForScore: 0, // score always computes; an operator can raise the floor to suppress noise
  autoPauseMinAcquisitions: 100,
  autoPauseMaxConversionRate: 0.02,
};

export function resolveGrowthCaps(cfg: GrowthConfig | undefined): GrowthCaps {
  return {
    enabled: cfg?.enabled ?? GROWTH_DEFAULTS.enabled,
    minTrafficForScore: cfg?.minTrafficForScore ?? GROWTH_DEFAULTS.minTrafficForScore,
    autoPauseMinAcquisitions:
      cfg?.autoPauseMinAcquisitions ?? GROWTH_DEFAULTS.autoPauseMinAcquisitions,
    autoPauseMaxConversionRate:
      cfg?.autoPauseMaxConversionRate ?? GROWTH_DEFAULTS.autoPauseMaxConversionRate,
  };
}
