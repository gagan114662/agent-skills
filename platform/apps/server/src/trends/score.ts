/**
 * The pure ranking core for the trend-ingestion source (issue #743). No I/O, no clock, no database — given a
 * batch of {@link RawTrend}s, a requested niche, and the {@link TrendCaps} weighting, it returns the final
 * ranked {@link TrendRecord} list. This is the testable heart of the module (the proven pure-core + injected-
 * seam pattern): the service layer only fetches and persists; ALL ranking, niche filtering, format coercion,
 * and in-batch dedupe live here so they can be unit-tested with no infrastructure.
 *
 * Determinism is a hard requirement: the same inputs always yield the same order. Ties are broken structurally
 * (score, then hook, then sourceRef) so two records can never reorder run-to-run.
 */

import { TREND_DEFAULTS, type TrendCaps } from "./caps.js";
import { TREND_FORMATS, type RawTrend, type TrendFormat, type TrendRecord } from "./types.js";

/** Clamp a number to [0, 1]; non-finite ⇒ 0 (a misbehaving source can never push a signal out of range). */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Coerce an arbitrary source-reported format string to a known {@link TrendFormat}; unknown ⇒ `"short"`. */
export function coerceFormat(raw: string): TrendFormat {
  const norm = raw.trim().toLowerCase();
  return (TREND_FORMATS as readonly string[]).includes(norm) ? (norm as TrendFormat) : "short";
}

/** Collapse internal whitespace and lowercase — the normal form used for niche matching and dedupe. */
export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The (hook + format) identity two trends are considered duplicates on within a niche. Normalizing the hook
 * means trivial whitespace/case variants of the same hook collapse to one record (the higher-scoring wins).
 */
export function dedupeKey(hook: string, format: TrendFormat): string {
  return `${normalizeText(hook)}|${format}`;
}

/**
 * Recency contribution in (0, 1]: exponential decay with the caps half-life. A 0-day-old trend scores 1.0; at
 * exactly the half-life it scores 0.5; it asymptotes toward 0 but never reaches it. Negative ages are treated
 * as 0 (fresh).
 */
export function recencyScore(recencyDays: number, halfLifeDays: number): number {
  const age = Number.isFinite(recencyDays) && recencyDays > 0 ? recencyDays : 0;
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : TREND_DEFAULTS.recencyHalfLifeDays;
  return Math.pow(0.5, age / halfLife);
}

/**
 * Score a single trend's signals into a 0–100 integer. Pure + total: signals are clamped, recency is decayed,
 * the three weighted contributions (caps weights already sum to 1) compose onto 0..1, then expand to 0–100.
 */
export function scoreSignals(
  signals: { popularity: number; recencyDays: number; relevance: number },
  caps: TrendCaps,
): number {
  const popularity = clamp01(signals.popularity);
  const relevance = clamp01(signals.relevance);
  const recency = recencyScore(signals.recencyDays, caps.recencyHalfLifeDays);
  const composite =
    caps.weightPopularity * popularity + caps.weightRecency * recency + caps.weightRelevance * relevance;
  return Math.round(clamp01(composite) * 100);
}

/**
 * Rank a batch of raw trends for one niche.
 *
 * Steps, in order:
 *   1. Empty/whitespace niche ⇒ `[]` (there is nothing to rank for "no niche").
 *   2. Keep only trends whose niche matches the request (case/whitespace-insensitive).
 *   3. Score each survivor; coerce its format to a known value.
 *   4. Dedupe on (normalized hook + format): the highest-scoring instance wins; ties keep the lexically
 *      smaller sourceRef so the choice is deterministic.
 *   5. Sort by score desc, then hook asc, then sourceRef asc.
 *   6. Apply the caps `maxResults` cap (0 ⇒ unlimited).
 *
 * The returned `niche` on every record is the normalized requested niche, so downstream consumers see one
 * canonical spelling regardless of how the source cased it.
 */
export function rankTrends(raws: readonly RawTrend[], niche: string, caps: TrendCaps): TrendRecord[] {
  const wantNiche = normalizeText(niche);
  if (wantNiche.length === 0) return [];

  const best = new Map<string, TrendRecord>();
  for (const raw of raws) {
    if (normalizeText(raw.niche) !== wantNiche) continue;
    const format = coerceFormat(raw.format);
    const record: TrendRecord = {
      hook: raw.hook.trim(),
      format,
      niche: wantNiche,
      score: scoreSignals(raw.signals, caps),
      sourceRef: raw.sourceRef.trim(),
    };
    const key = dedupeKey(record.hook, format);
    const existing = best.get(key);
    if (!existing || isBetter(record, existing)) best.set(key, record);
  }

  const ranked = [...best.values()].sort(compareRanked);
  const limit = caps.maxResults > 0 ? Math.trunc(caps.maxResults) : ranked.length;
  return ranked.slice(0, limit);
}

/** Is `a` the better of two duplicate records? Higher score wins; ties keep the smaller sourceRef. */
function isBetter(a: TrendRecord, b: TrendRecord): boolean {
  if (a.score !== b.score) return a.score > b.score;
  return a.sourceRef.localeCompare(b.sourceRef) < 0;
}

/** Final ranking order: score desc, then hook asc, then sourceRef asc — total and deterministic. */
function compareRanked(a: TrendRecord, b: TrendRecord): number {
  if (a.score !== b.score) return b.score - a.score;
  const byHook = a.hook.localeCompare(b.hook);
  if (byHook !== 0) return byHook;
  return a.sourceRef.localeCompare(b.sourceRef);
}
