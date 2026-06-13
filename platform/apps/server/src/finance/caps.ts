import type { FinanceConfig } from "../config/schema.js";

/**
 * Resolve the Finance Ledger policy from the layered config (#58), applying hard defaults — mirrors
 * `founder-briefings/caps.ts`. The feature is **default OFF** (`enabled: false`), owner-workspace-first:
 * a deployment that sets no `finance` block runs no posting/close tick and the read routes answer 409.
 * `enabled` is the master switch for the engine (posting + monthly close) AND the read surface; even when
 * enabled, nothing here can move money (the `finance.disbursement` action stays human-gated + recorded-only).
 */
export interface FinanceCaps {
  /** Master flag for the posting/close tick + the read routes + the weekly section. OFF by default. */
  enabled: boolean;
  /** Lookback (months) for the runway burn-rate + the recent-periods forecast basis. */
  lookbackMonths: number;
  /** Cash floor (cents) the runway/recommendation treat as "0" — a breach is predicted at this line. */
  floorCents: number;
  /** At/below this many post-spend runway days a money decision is recommended `caution`. */
  cautionRunwayDays: number;
  /** Months-to-breach at/below which the runway header reads `at_risk`. */
  atRiskMonths: number;
  /** Max ledger rows a single read/CSV export returns. */
  ledgerLimit: number;
}

export const FINANCE_DEFAULTS: FinanceCaps = {
  enabled: false,
  lookbackMonths: 6,
  floorCents: 0,
  cautionRunwayDays: 30,
  atRiskMonths: 3,
  ledgerLimit: 500,
};

export function resolveFinanceCaps(cfg: FinanceConfig | undefined): FinanceCaps {
  return {
    enabled: cfg?.enabled ?? FINANCE_DEFAULTS.enabled,
    lookbackMonths: cfg?.lookbackMonths ?? FINANCE_DEFAULTS.lookbackMonths,
    floorCents: cfg?.floorCents ?? FINANCE_DEFAULTS.floorCents,
    cautionRunwayDays: cfg?.cautionRunwayDays ?? FINANCE_DEFAULTS.cautionRunwayDays,
    atRiskMonths: cfg?.atRiskMonths ?? FINANCE_DEFAULTS.atRiskMonths,
    ledgerLimit: cfg?.ledgerLimit ?? FINANCE_DEFAULTS.ledgerLimit,
  };
}
