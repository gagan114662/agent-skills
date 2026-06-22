/**
 * Configuration for the competitive-intelligence module (issue #619). Deliberately **self-contained**: every
 * tunable is read straight from the process environment, so this feature adds NO edit to the shared
 * `config/schema.ts` barrel and stays free of parallel-merge conflicts with sibling branches (the proven
 * #670/#674/#587 pattern).
 *
 * Default **OFF**. Like the money/irreversible gates, tracking real competitors means reaching out to the
 * outside world, so the safe default makes the module inert against external systems: with `enabled=false`
 * the service serves deterministic offline FAKE data and makes NO network call. A deployment opts in by
 * setting `COMPETITIVE_INTEL_ENABLED=1` and injecting a real source.
 */

/** Default minimum relative price move (fraction, e.g. 0.05 = 5%) to count as a MATERIAL pricing change. */
export const DEFAULT_PRICE_CHANGE_MIN_PCT = 0;

/** Default cap on how many changes a single digest carries (newest/most-material first). */
export const DEFAULT_MAX_DIGEST_CHANGES = 100;

/** Default cap on how many highlight lines a digest surfaces. */
export const DEFAULT_MAX_HIGHLIGHTS = 5;

export interface CompetitiveIntelCaps {
  /** Master switch. OFF by default: when false the service uses the offline fake source (no external call). */
  enabled: boolean;
  /**
   * Minimum relative price change to report (fraction). 0 ⇒ any price change is material. A tier whose price
   * moves by less than this fraction is treated as unchanged. Tier add/remove is always material regardless.
   */
  priceChangeMinPct: number;
  /** Hard cap on the number of changes in one digest. */
  maxDigestChanges: number;
  /** Hard cap on the number of highlight lines. */
  maxHighlights: number;
}

export const COMPETITIVE_INTEL_DEFAULTS: CompetitiveIntelCaps = {
  enabled: false,
  priceChangeMinPct: DEFAULT_PRICE_CHANGE_MIN_PCT,
  maxDigestChanges: DEFAULT_MAX_DIGEST_CHANGES,
  maxHighlights: DEFAULT_MAX_HIGHLIGHTS,
};

/**
 * Parse a boolean-ish env flag with a default. `1`/`true`/`yes`/`on` ⇒ true, `0`/`false`/`no`/`off` ⇒ false
 * (case-insensitive); anything else (including unset) keeps `fallback`.
 */
function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/** Parse a finite, non-negative number; missing/invalid ⇒ the provided default. */
function parseNonNeg(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Parse a positive integer; missing/invalid/non-positive ⇒ the provided default. */
function parsePosInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

/** Resolve the caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveCompetitiveIntelCaps(
  env: NodeJS.ProcessEnv = process.env,
): CompetitiveIntelCaps {
  return {
    enabled: envFlag(env.COMPETITIVE_INTEL_ENABLED, COMPETITIVE_INTEL_DEFAULTS.enabled),
    priceChangeMinPct: parseNonNeg(
      env.COMPETITIVE_INTEL_PRICE_CHANGE_MIN_PCT,
      DEFAULT_PRICE_CHANGE_MIN_PCT,
    ),
    maxDigestChanges: parsePosInt(env.COMPETITIVE_INTEL_MAX_DIGEST_CHANGES, DEFAULT_MAX_DIGEST_CHANGES),
    maxHighlights: parsePosInt(env.COMPETITIVE_INTEL_MAX_HIGHLIGHTS, DEFAULT_MAX_HIGHLIGHTS),
  };
}
