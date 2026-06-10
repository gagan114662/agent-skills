import type { MarketingConfig } from "../config/schema.js";

/**
 * Resolve the marketing-fleet policy from the layered config (#58), applying hard defaults — mirrors
 * `venture/caps.ts` and `watchdog/caps.ts`. **Default OFF**: a deployment that sets no `marketing`
 * section keeps today's signup behavior (no auto-seed); ipop.ai opts in via the managed layer. The
 * explicit seed route always works regardless of `enabled` — `enabled` gates only seed-on-signup.
 */
export interface MarketingCaps {
  /** Auto-seed the department fleet on signup. OFF by default. */
  enabled: boolean;
  /** Launch one welcome session per department on seed (the "prove each agent alive" brief). */
  seedWelcomeTasks: boolean;
}

export const MARKETING_DEFAULTS: MarketingCaps = {
  enabled: false,
  seedWelcomeTasks: true,
};

export function resolveMarketingCaps(cfg: MarketingConfig | undefined): MarketingCaps {
  return {
    enabled: cfg?.enabled ?? MARKETING_DEFAULTS.enabled,
    seedWelcomeTasks: cfg?.seedWelcomeTasks ?? MARKETING_DEFAULTS.seedWelcomeTasks,
  };
}
