/**
 * Spend-cap governor config (issue #670). Deliberately **self-contained**: the master switch and alert
 * threshold are read directly from the process environment so this feature adds NO edits to the shared
 * `config/schema.ts` barrel — keeping the #670 change set free of parallel-merge conflicts with sibling
 * branches. The per-workspace cap amount itself is NOT config; it is persisted governor state, raisable
 * only through a recorded human approval (see `budget/service.ts`).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs an
 * inert governor and the read/mutation routes answer 409.
 */

import { DEFAULT_ALERT_THRESHOLD_BPS } from "./governor.js";

export interface BudgetGovernorCaps {
  /** Master switch for the governor + its routes. OFF by default. */
  enabled: boolean;
  /** Utilization (basis points, 0–10000) at which the user is alerted. Default 80%. */
  alertThresholdBps: number;
}

export const BUDGET_GOVERNOR_DEFAULTS: BudgetGovernorCaps = {
  enabled: false,
  alertThresholdBps: DEFAULT_ALERT_THRESHOLD_BPS,
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse an alert-threshold env value, clamped to [0, 10000]; a missing/invalid value keeps the default. */
function envThresholdBps(raw: string | undefined): number {
  if (raw === undefined) return BUDGET_GOVERNOR_DEFAULTS.alertThresholdBps;
  const n = Number(raw);
  if (!Number.isFinite(n)) return BUDGET_GOVERNOR_DEFAULTS.alertThresholdBps;
  return Math.min(10_000, Math.max(0, Math.trunc(n)));
}

/** Resolve the governor caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveBudgetGovernorCaps(env: NodeJS.ProcessEnv = process.env): BudgetGovernorCaps {
  return {
    enabled: envFlag(env.BUDGET_GOVERNOR_ENABLED),
    alertThresholdBps: envThresholdBps(env.BUDGET_GOVERNOR_ALERT_BPS),
  };
}
