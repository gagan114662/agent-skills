/**
 * Per-channel spend-governor config (issue #591). Deliberately **self-contained**: the master switch, the
 * period length, and the alert threshold are read directly from the process environment, so this feature adds
 * NO edits to the shared `config/schema.ts` barrel — keeping the #591 change set free of parallel-merge
 * conflicts with sibling branches. The per-channel cap amounts themselves are NOT config; they are persisted
 * governor state, raisable only through a recorded human approval (see `spend-governor/service.ts`).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs an
 * inert governor that allows everything and reserves nothing.
 */

import { DEFAULT_ALERT_THRESHOLD_BPS } from "./governor.js";

/** One day in milliseconds — the default spend period (a daily channel cap that refills each day). */
export const DEFAULT_PERIOD_MS = 24 * 60 * 60 * 1_000;

export interface SpendGovernorCaps {
  /** Master switch for the governor. OFF by default. */
  enabled: boolean;
  /** Length of a spend period in milliseconds; caps refill at each period boundary. Default 1 day. */
  periodMs: number;
  /** Utilization (basis points, 0–10000) at which the user is alerted. Default 80%. */
  alertThresholdBps: number;
}

export const SPEND_GOVERNOR_DEFAULTS: SpendGovernorCaps = {
  enabled: false,
  periodMs: DEFAULT_PERIOD_MS,
  alertThresholdBps: DEFAULT_ALERT_THRESHOLD_BPS,
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse the period length (seconds) into ms, clamped to a sane minimum; a missing/invalid value keeps default. */
function envPeriodMs(raw: string | undefined): number {
  if (raw === undefined) return SPEND_GOVERNOR_DEFAULTS.periodMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return SPEND_GOVERNOR_DEFAULTS.periodMs;
  // Never shorter than one minute, so a typo can't make periods churn pathologically.
  return Math.max(60_000, Math.trunc(seconds) * 1_000);
}

/** Parse an alert-threshold env value, clamped to [0, 10000]; a missing/invalid value keeps the default. */
function envThresholdBps(raw: string | undefined): number {
  if (raw === undefined) return SPEND_GOVERNOR_DEFAULTS.alertThresholdBps;
  const n = Number(raw);
  if (!Number.isFinite(n)) return SPEND_GOVERNOR_DEFAULTS.alertThresholdBps;
  return Math.min(10_000, Math.max(0, Math.trunc(n)));
}

/** Resolve the governor caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveSpendGovernorCaps(env: NodeJS.ProcessEnv = process.env): SpendGovernorCaps {
  return {
    enabled: envFlag(env.SPEND_GOVERNOR_ENABLED),
    periodMs: envPeriodMs(env.SPEND_GOVERNOR_PERIOD_SECONDS),
    alertThresholdBps: envThresholdBps(env.SPEND_GOVERNOR_ALERT_BPS),
  };
}
