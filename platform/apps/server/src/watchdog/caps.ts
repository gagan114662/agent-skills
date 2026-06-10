import type { WatchdogConfig } from "../config/schema.js";
import type { WatchdogThresholds } from "./types.js";

/**
 * Resolve the watchdog policy from the layered config (#58), applying hard defaults — mirrors
 * `scale/caps.ts` and `venture/caps.ts`. The supervisor is **default OFF** (`enabled: false`): a
 * deployment that sets no `watchdog` section keeps today's #25 behavior (no detection, no revival),
 * and the background timer is also default-off (`WATCHDOG_INTERVAL_MS = 0`).
 */
export interface WatchdogCaps {
  /** The supervisor flag. OFF by default. */
  enabled: boolean;
  /** No-progress age (ms) at/above which a non-terminal session is stalled. */
  staleCutoffMs: number;
  /** Hard cap on revivals per rolling window before escalation (0 = never revive). */
  maxRevivalsPerWindow: number;
  /** Length (ms) of the rolling revival window. */
  windowMs: number;
  /** Minimum time (ms) between revivals of one lineage (the backoff). */
  backoffMs: number;
}

export const WATCHDOG_DEFAULTS: WatchdogCaps = {
  enabled: false,
  staleCutoffMs: 5 * 60_000, // 5 min with no heartbeat → stalled
  maxRevivalsPerWindow: 3,
  windowMs: 60 * 60_000, // 1 hour rolling window
  backoffMs: 30_000, // 30s between revivals
};

export function resolveWatchdogCaps(cfg: WatchdogConfig | undefined): WatchdogCaps {
  return {
    enabled: cfg?.enabled ?? WATCHDOG_DEFAULTS.enabled,
    staleCutoffMs: cfg?.staleCutoffMs ?? WATCHDOG_DEFAULTS.staleCutoffMs,
    maxRevivalsPerWindow: cfg?.maxRevivalsPerWindow ?? WATCHDOG_DEFAULTS.maxRevivalsPerWindow,
    windowMs: cfg?.windowMs ?? WATCHDOG_DEFAULTS.windowMs,
    backoffMs: cfg?.backoffMs ?? WATCHDOG_DEFAULTS.backoffMs,
  };
}

/** Project the decision thresholds out of the resolved caps. */
export function watchdogThresholds(caps: WatchdogCaps): WatchdogThresholds {
  return {
    staleCutoffMs: caps.staleCutoffMs,
    maxRevivalsPerWindow: caps.maxRevivalsPerWindow,
    windowMs: caps.windowMs,
    backoffMs: caps.backoffMs,
  };
}
