/**
 * Trend-ingestion source (issue #743) — the shared record shapes.
 *
 * This module produces a ranked list of {@link TrendRecord} for a given niche so the video agent (#740) can
 * consume each as a ready-to-use creative brief (a `hook` to open with + a `format` to shoot in). The five
 * fields the issue pins — `{ hook, format, niche, score, sourceRef }` — ARE the public {@link TrendRecord};
 * everything else here is either the pre-ranking input ({@link RawTrend}) the injected source seam yields, or
 * the persistence superset ({@link StoredTrendRecord}) the self-managed store returns.
 *
 * The scorer input ({@link TrendSignals}) is deliberately raw + provider-agnostic: a source maps whatever it
 * read (views, age, niche fit) onto these three normalized signals, and the pure ranking core in `score.ts`
 * turns them into the 0–100 `score`. No field here trusts a provider's claimed score — the rank is always
 * recomputed locally (#200 §6: provider output is untrusted DATA).
 */

/**
 * The content formats a trend can be shot in — a closed set the video agent (#740) understands. Kept narrow
 * and video-oriented on purpose: an unknown free-text format from a source is coerced to `"short"` (the safe,
 * most common default) by {@link coerceFormat} rather than flowing through unvalidated.
 */
export const TREND_FORMATS = ["short", "long", "reel", "story", "live", "carousel"] as const;

export type TrendFormat = (typeof TREND_FORMATS)[number];

/**
 * Normalized 0..1 signals a source extracts from whatever it read. The pure scorer weights these into the
 * final score; clamping to valid ranges happens in the scorer so a misbehaving source can never push a score
 * out of 0–100.
 */
export interface TrendSignals {
  /** Reach/engagement, normalized to 0..1 (1 = the most-seen thing the source found). */
  popularity: number;
  /** Age of the trend in days (>= 0). Fresher = higher score; decays on the caps half-life. */
  recencyDays: number;
  /** How well the trend matches the requested niche, 0..1 (1 = a perfect topical fit). */
  relevance: number;
}

/**
 * A trend as a source yields it, BEFORE ranking: the creative payload (`hook`/`format`), the `niche` it belongs
 * to, a stable `sourceRef` (URL / provider id for attribution + dedupe), and the raw {@link TrendSignals} the
 * scorer consumes. `format` is `string` here (a source may report anything) and is coerced to a valid
 * {@link TrendFormat} during ranking.
 */
export interface RawTrend {
  hook: string;
  format: string;
  niche: string;
  sourceRef: string;
  signals: TrendSignals;
}

/**
 * The public, ranked output — exactly the five fields issue #743 specifies, and the precise shape the video
 * agent (#740) consumes. `score` is a 0–100 integer; the list is returned sorted by it, descending.
 */
export interface TrendRecord {
  hook: string;
  format: TrendFormat;
  niche: string;
  score: number;
  sourceRef: string;
}

/** The persistence superset the self-managed store returns: a {@link TrendRecord} plus its row metadata. */
export interface StoredTrendRecord extends TrendRecord {
  id: string;
  workspaceId: string;
  /** The normalized (hook+format) identity the store dedupes on within a (workspace, niche). */
  dedupeKey: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The video agent's input brief (#740): the ranked trend stripped to what a video needs — an opening `hook`,
 * the `format` to shoot it in, the `niche`, and the `sourceRef` for attribution. Produced by `toVideoBriefs`.
 */
export interface TrendVideoBrief {
  hook: string;
  format: TrendFormat;
  niche: string;
  sourceRef: string;
}
