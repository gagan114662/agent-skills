/**
 * Fleet dead-man's switch config (issue #592). Deliberately **self-contained**: the master switch and the
 * per-metric tripwire ceilings are read directly from the process environment so this feature adds NO edits to
 * the shared `config/schema.ts` barrel — keeping the #592 change set free of parallel-merge conflicts with
 * sibling branches (the same pattern as #670 budget-governor and #674 content-guard).
 *
 * Default **OFF**: a deployment that sets nothing runs an inert switch — `evaluate()` never trips and the
 * fleet is never reported paused. Setting `KILL_SWITCH_ENABLED` arms the switch; the manual global kill is
 * available regardless of which (if any) tripwire ceilings are configured, so an operator can always halt the
 * fleet by hand. A ceiling that is unset / non-positive leaves that metric unmonitored.
 */

import type { TripwireThresholds } from "./tripwire.js";

export interface KillSwitchCaps {
  /** Master switch for the dead-man's switch + its tripwire evaluation. OFF by default. */
  enabled: boolean;
  /** The tripwire ceilings (a `null` ceiling leaves that metric unmonitored). */
  thresholds: TripwireThresholds;
}

export const KILL_SWITCH_DEFAULTS: KillSwitchCaps = {
  enabled: false,
  thresholds: {
    maxSpendPerHourCents: null,
    maxErrorRateBps: null,
    maxBounceRateBps: null,
  },
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Parse a tripwire ceiling: a missing / blank / non-finite / non-positive value leaves the metric UNMONITORED
 * (`null`). Only an explicit positive integer arms a tripwire — so a typo never silently trips the fleet.
 */
function envCeiling(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/** Resolve the dead-man's switch caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveKillSwitchCaps(env: NodeJS.ProcessEnv = process.env): KillSwitchCaps {
  return {
    enabled: envFlag(env.KILL_SWITCH_ENABLED),
    thresholds: {
      maxSpendPerHourCents: envCeiling(env.KILL_SWITCH_MAX_SPEND_PER_HOUR_CENTS),
      maxErrorRateBps: envCeiling(env.KILL_SWITCH_MAX_ERROR_RATE_BPS),
      maxBounceRateBps: envCeiling(env.KILL_SWITCH_MAX_BOUNCE_RATE_BPS),
    },
  };
}
