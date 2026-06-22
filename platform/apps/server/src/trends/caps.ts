/**
 * Configuration for the trend-ingestion source (issue #743). Deliberately **self-contained**: every tunable is
 * read straight from the process environment, so this feature adds NO edit to the shared config schema barrel
 * and stays free of parallel-merge conflicts with sibling branches (the proven #670/#674/#587 pattern).
 *
 * The single most important default is `enabled: false`. While disabled (the default), the service NEVER calls
 * a live/network source — it serves the deterministic in-repo FIXTURE instead. A live source only runs once an
 * operator sets `TRENDS_ENABLED=1`, so the module ships dark and makes zero network calls until switched on.
 *
 * The scorer weights are pure tuning of the ranking core and are normalized to sum to 1, so the composite score
 * always lands on a comparable 0..1 scale before it is expanded to the 0–100 integer.
 */

/** Default scorer weights (normalized to sum to 1) and recency half-life. */
export const DEFAULT_WEIGHT_POPULARITY = 0.45;
export const DEFAULT_WEIGHT_RECENCY = 0.25;
export const DEFAULT_WEIGHT_RELEVANCE = 0.3;
/** Days at which a trend's recency contribution halves (exponential decay). */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;
/** Default cap on how many ranked records the service returns (0 ⇒ unlimited). */
export const DEFAULT_MAX_RESULTS = 25;

export interface TrendCaps {
  /**
   * Master switch. `false` (default) ⇒ the live source is never invoked and the deterministic fixture is
   * served instead — no network calls. `true` ⇒ the injected live source runs, falling back to the fixture on
   * error.
   */
  enabled: boolean;
  /** Weight on popularity (0..1, pre-normalization). */
  weightPopularity: number;
  /** Weight on recency (0..1, pre-normalization). */
  weightRecency: number;
  /** Weight on niche relevance (0..1, pre-normalization). */
  weightRelevance: number;
  /** Recency half-life in days (> 0). */
  recencyHalfLifeDays: number;
  /** Max records returned (>= 0; 0 ⇒ unlimited). */
  maxResults: number;
}

export const TREND_DEFAULTS: TrendCaps = {
  enabled: false,
  weightPopularity: DEFAULT_WEIGHT_POPULARITY,
  weightRecency: DEFAULT_WEIGHT_RECENCY,
  weightRelevance: DEFAULT_WEIGHT_RELEVANCE,
  recencyHalfLifeDays: DEFAULT_RECENCY_HALF_LIFE_DAYS,
  maxResults: DEFAULT_MAX_RESULTS,
};

/** Parse a boolean flag — only the explicit truthy tokens enable; everything else (incl. unset) ⇒ false. */
function parseBool(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a finite, non-negative number; missing/invalid ⇒ the provided default. */
function parseNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Parse a strictly-positive number; missing/invalid/non-positive ⇒ the provided default. */
function parsePositive(raw: string | undefined, fallback: number): number {
  const n = parseNum(raw, fallback);
  return n > 0 ? n : fallback;
}

/** Parse a non-negative integer; missing/invalid ⇒ the provided default. */
function parseIntCap(raw: string | undefined, fallback: number): number {
  const n = parseNum(raw, fallback);
  return Math.trunc(n);
}

/**
 * Resolve the caps from the environment (defaults applied). Pure given its `env` argument. The three scorer
 * weights are normalized to sum to 1; if all three are zero (a misconfiguration) the safe defaults are
 * restored so the ranking core always has a usable, comparable weighting.
 */
export function resolveTrendCaps(env: NodeJS.ProcessEnv = process.env): TrendCaps {
  let wPop = parseNum(env.TRENDS_WEIGHT_POPULARITY, DEFAULT_WEIGHT_POPULARITY);
  let wRec = parseNum(env.TRENDS_WEIGHT_RECENCY, DEFAULT_WEIGHT_RECENCY);
  let wRel = parseNum(env.TRENDS_WEIGHT_RELEVANCE, DEFAULT_WEIGHT_RELEVANCE);
  const sum = wPop + wRec + wRel;
  if (sum <= 0) {
    wPop = DEFAULT_WEIGHT_POPULARITY;
    wRec = DEFAULT_WEIGHT_RECENCY;
    wRel = DEFAULT_WEIGHT_RELEVANCE;
  } else {
    wPop /= sum;
    wRec /= sum;
    wRel /= sum;
  }
  return {
    enabled: parseBool(env.TRENDS_ENABLED),
    weightPopularity: wPop,
    weightRecency: wRec,
    weightRelevance: wRel,
    recencyHalfLifeDays: parsePositive(env.TRENDS_RECENCY_HALF_LIFE_DAYS, DEFAULT_RECENCY_HALF_LIFE_DAYS),
    maxResults: parseIntCap(env.TRENDS_MAX_RESULTS, DEFAULT_MAX_RESULTS),
  };
}
