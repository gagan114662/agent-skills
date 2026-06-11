import type { InsightInput, SourceInput, SourceKind } from "./types.js";

/**
 * Pure ranking for the Insight Miner (#100). No IO — the single source of truth for how candidate
 * sources and mined insights are scored, so every required path is a fast unit test. Two ideas:
 *   - "the list is the strategy": `rankSource` scores a candidate BEFORE it is mined, so scarce
 *     mining budget is spent on the highest-evidence sources first.
 *   - insights rank **multiplicatively** (`rankInsight`): freshness × pain intensity × competition
 *     absence — a zero on any axis zeroes the insight, so an asymmetric secret must win on all three.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Exponential recency decay in (0, 1]: 1 at `observedAt = now`, 0.5 at one half-life, → 0 far past.
 * Future timestamps clamp to 1 (never exceeds 1); a non-positive half-life disables decay (always 1).
 */
export function freshnessFactor(observedAt: Date, now: Date, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const ageDays = (now.getTime() - observedAt.getTime()) / DAY_MS;
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Kind authority (0–1). The **owner secret** is the only *true* secret → highest. Primary cited pain
 * sources (support forums, reviews, communities) rank above secondary why-now signals (regulation,
 * changelogs, model capabilities, pricing) because direct user pain is stronger evidence than a delta.
 */
const SOURCE_AUTHORITY: Record<SourceKind, number> = {
  owner_secret: 1.0,
  support_forum: 0.9,
  reviews: 0.85,
  community: 0.8,
  regulation: 0.7,
  api_changelog: 0.65,
  model_capability: 0.6,
  pricing: 0.55,
};

/** Evidence strength of a candidate source BEFORE mining: kind authority × freshness, scaled 0–100. */
export function rankSource(
  source: Pick<SourceInput, "kind" | "observedAt">,
  now: Date,
  halfLifeDays: number,
): number {
  const authority = SOURCE_AUTHORITY[source.kind] ?? 0.5;
  return Math.round(authority * freshnessFactor(source.observedAt, now, halfLifeDays) * 100);
}

/**
 * Insight rank: **freshness × pain intensity × competition absence**, each factor normalised to 0–1
 * and the product scaled to 0–100. Multiplicative by design (decision 3 of ADR-0100): a stale,
 * painless, or crowded insight cannot rank highly no matter how strong the other two axes.
 */
export function rankInsight(
  insight: Pick<InsightInput, "painIntensity" | "competitionAbsence" | "freshnessAt">,
  now: Date,
  halfLifeDays: number,
): number {
  const freshness = freshnessFactor(insight.freshnessAt, now, halfLifeDays);
  const pain = clamp01(insight.painIntensity / 10);
  const competition = clamp01(insight.competitionAbsence / 10);
  return Math.round(freshness * pain * competition * 100);
}

/** Order by score (desc), newest-first on ties — the pipeline/source-list ordering. */
export function sortByScore<T extends { score: number; createdAt: Date }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime(),
  );
}
