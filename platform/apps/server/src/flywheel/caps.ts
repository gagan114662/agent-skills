import type { FlywheelConfig } from "../config/schema.js";

/**
 * Resolve the flywheel policy from the layered config (#58), applying hard defaults — mirrors
 * `watchdog/caps.ts` and `venture/caps.ts`. The flywheel is **default OFF** (`enabled: false`): a
 * deployment that sets no `flywheel` section files no issues and dispatches no fixes, and the
 * background tick is also default-off (`FLYWHEEL_INTERVAL_MS = 0`).
 */
export interface FlywheelCaps {
  /** The flywheel flag. OFF by default. */
  enabled: boolean;
  /** Occurrence count at/above which a never-issued fingerprint earns a drafted issue. */
  issueThreshold: number;
  /** Hard cap on NEW issues drafted in a single tick (the GitHub-write rate limit). */
  maxIssuesPerTick: number;
  /** Hard cap on concurrent in-flight fix sessions per workspace (the blast-radius bound). */
  maxConcurrentFixes: number;
  /** Hard cap on fix dispatches proposed in a single tick (top-ranked first). */
  maxDispatchesPerTick: number;
}

export const FLYWHEEL_DEFAULTS: FlywheelCaps = {
  enabled: false,
  issueThreshold: 1, // a single occurrence is enough to file (failures are signal)
  maxIssuesPerTick: 3, // bound GitHub writes per pass
  maxConcurrentFixes: 1, // one self-healing fix in flight per workspace by default
  maxDispatchesPerTick: 1, // only the top-ranked fingerprint-issue per tick
};

export function resolveFlywheelCaps(cfg: FlywheelConfig | undefined): FlywheelCaps {
  return {
    enabled: cfg?.enabled ?? FLYWHEEL_DEFAULTS.enabled,
    issueThreshold: cfg?.issueThreshold ?? FLYWHEEL_DEFAULTS.issueThreshold,
    maxIssuesPerTick: cfg?.maxIssuesPerTick ?? FLYWHEEL_DEFAULTS.maxIssuesPerTick,
    maxConcurrentFixes: cfg?.maxConcurrentFixes ?? FLYWHEEL_DEFAULTS.maxConcurrentFixes,
    maxDispatchesPerTick: cfg?.maxDispatchesPerTick ?? FLYWHEEL_DEFAULTS.maxDispatchesPerTick,
  };
}
