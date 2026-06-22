/**
 * Weekly growth report config (issue #620). Deliberately **self-contained**: the master switch and the
 * number of next bets to surface are read directly from the process environment, so this feature adds NO
 * edits to the shared `config/schema.ts` barrel — keeping the #620 change set free of parallel-merge
 * conflicts with sibling branches (same pattern as the #670 spend-cap governor and #676 backup module).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing produces
 * no reports, and the (deliberately un-wired) generate path is inert until `GROWTH_REPORT_ENABLED` is set.
 */

/** Defaults applied when the corresponding env var is unset or invalid. */
export const GROWTH_REPORT_DEFAULTS = {
  enabled: false,
  /** How many recommended next bets to surface in a report. */
  maxNextBets: 5,
} as const;

export interface GrowthReportCaps {
  /** Master switch for report generation. OFF by default. */
  enabled: boolean;
  /** Maximum number of recommended next bets surfaced per report (>= 1). */
  maxNextBets: number;
}

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a positive integer env value with a floor of 1; a missing/invalid value keeps the default. */
function envPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.trunc(n));
}

/** Resolve the growth-report caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveGrowthReportCaps(env: NodeJS.ProcessEnv = process.env): GrowthReportCaps {
  return {
    enabled: envFlag(env.GROWTH_REPORT_ENABLED),
    maxNextBets: envPositiveInt(env.GROWTH_REPORT_MAX_NEXT_BETS, GROWTH_REPORT_DEFAULTS.maxNextBets),
  };
}
