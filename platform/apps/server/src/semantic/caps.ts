/**
 * Fleet caps (#155, ADR-0155). Resolves the shared `fleet` config block (#58 layering) into hard
 * defaults — read by BOTH the semantic layer (freshness ceiling) and the eval module (regression
 * tolerance + the proactive eval-tick flag). Default **OFF** (`enabled:false`): catalog reads + metric
 * answers stay always-on; `enabled` gates only the proactive eval maintenance tick + flywheel feed.
 */

import type { FleetConfig } from "../config/schema.js";

export interface FleetCaps {
  /** The proactive eval-maintenance flag. OFF by default. Reads do not consult it. */
  enabled: boolean;
  /** Freshness ceiling in ms — a metric answer older than this is flagged stale. */
  freshnessMaxAgeMs: number;
  /** Allowed pass-rate slip (0–1) before an eval run is a regression that feeds the #117 flywheel. */
  evalRegressionTolerance: number;
}

const HOUR_MS = 3_600_000;

export const FLEET_DEFAULTS: FleetCaps = {
  enabled: false,
  freshnessMaxAgeMs: 24 * HOUR_MS, // a day-old number is stale by default
  evalRegressionTolerance: 0, // any real drop is a regression
};

export function resolveFleetCaps(cfg: FleetConfig | undefined): FleetCaps {
  return {
    enabled: cfg?.enabled ?? FLEET_DEFAULTS.enabled,
    freshnessMaxAgeMs:
      cfg?.freshnessMaxAgeHours !== undefined
        ? Math.max(0, cfg.freshnessMaxAgeHours) * HOUR_MS
        : FLEET_DEFAULTS.freshnessMaxAgeMs,
    evalRegressionTolerance: cfg?.evalRegressionTolerance ?? FLEET_DEFAULTS.evalRegressionTolerance,
  };
}
