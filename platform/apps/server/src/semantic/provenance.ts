/**
 * Provenance + freshness (#155, ADR-0155 §3). **Pure**. The playbook's third rule — agents must be
 * structurally routed to governed definitions *before* raw data — only holds if every answer says which
 * path it took and how fresh it is. This module ranks the three paths and computes freshness against a
 * configurable max-age; `answer.ts` renders them in brand voice.
 */

/**
 * The path an answer took to its number, best-first:
 *  - `semantic_layer`     — a canonical metric function over governed data (the only reproducible number).
 *  - `curated_reference`  — a curated reference file a skill router pointed at (governed prose, not raw).
 *  - `raw_data`           — ad-hoc exploration of raw rows (the documented fallback; always flagged).
 */
export const ANSWER_PATHS = ["semantic_layer", "curated_reference", "raw_data"] as const;
export type AnswerPath = (typeof ANSWER_PATHS)[number];

/** Higher is better. Used to decide whether an answer is a fallback (anything below `semantic_layer`). */
export const PATH_RANK: Record<AnswerPath, number> = {
  semantic_layer: 3,
  curated_reference: 2,
  raw_data: 1,
};

/** A human pointer for the answer line — what the path means in one phrase. */
export const PATH_LABEL: Record<AnswerPath, string> = {
  semantic_layer: "semantic layer (canonical)",
  curated_reference: "curated reference",
  raw_data: "raw data (unverified)",
};

/** True iff the path is below the canonical semantic layer (i.e. a flagged fallback). */
export function isFallbackPath(path: AnswerPath): boolean {
  return PATH_RANK[path] < PATH_RANK.semantic_layer;
}

/** The freshness verdict for one answer. */
export interface Freshness {
  /** Epoch ms of the underlying data, or null when the source has no timestamp (e.g. an empty window). */
  asOfMs: number | null;
  /** Age in ms (`now - asOf`), or null when `asOfMs` is null. Never negative (clamped at 0). */
  ageMs: number | null;
  /** True when the data is older than the configured max age (or its timestamp is unknown). */
  stale: boolean;
}

/**
 * Compute freshness. An unknown timestamp is treated as stale (we cannot vouch for it). A `maxAgeMs ≤ 0`
 * means "never stale on age" (only an unknown timestamp is stale). The age is clamped at 0 so a clock skew
 * that puts data slightly in the future never reports a negative age.
 */
export function computeFreshness(asOfMs: number | null, nowMs: number, maxAgeMs: number): Freshness {
  if (asOfMs === null) return { asOfMs: null, ageMs: null, stale: true };
  const ageMs = Math.max(0, nowMs - asOfMs);
  const stale = maxAgeMs > 0 && ageMs > maxAgeMs;
  return { asOfMs, ageMs, stale };
}

/** Render an age in ms as a short human string ("just now", "3h ago", "2d ago"). */
export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "freshness unknown";
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
