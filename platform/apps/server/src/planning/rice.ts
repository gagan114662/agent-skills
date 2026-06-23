import type {
  BacklogEvidence,
  BacklogItemRecord,
  RankedBacklogItem,
  RiceBreakdown,
  RiceItemInputs,
} from "./types.js";
import { steeringMatchScore, type PlanningSteeringDirective } from "./steering.js";

/**
 * The Product Planning Loop RICE math (#115, ADR-0115). **Pure + unit-tested**: the service does the IO
 * (read the items, persist the spec, propose the session); these functions turn evidence counts into
 * the stored RICE inputs (`deriveRice`), score them (`scoreRice`), and rank the backlog (`rankBacklog`)
 * — the deterministic core, the #117 `rank.ts` / #102 `score.ts` split. Score is always *derived*,
 * never persisted, so the routes + the #104 console agree by construction.
 */

/** The standard RICE impact multipliers, indexed by the 0–4 severity tier (minimal → massive). */
export const IMPACT_MULTIPLIERS = [0.25, 0.5, 1, 2, 3] as const;

/** Clamp to an integer in `[min,max]`, treating NaN as `min`. */
function clampInt(value: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * The RICE confidence ladder: more independent corroborating sources → higher confidence. Mirrors the
 * standard {low 50%, medium 80%, high 100%} bands, with 0 sources → 0 (an uncorroborated guess).
 */
export function confidenceFromSources(corroboratingSources: number): number {
  const n = clampInt(corroboratingSources, 0, Number.MAX_SAFE_INTEGER);
  if (n <= 0) return 0;
  if (n === 1) return 50;
  if (n === 2) return 80;
  return 100;
}

/**
 * Turn raw evidence counts into the stored RICE inputs (the `backlog_items` columns). Reach = the
 * distinct corroborating signals; Impact = the 0–4 severity tier; Confidence% = the corroboration
 * ladder; Effort = the agent estimate (≥ 1). All clamped so a bad count can never poison the score.
 */
export function deriveRice(evidence: BacklogEvidence): RiceItemInputs {
  return {
    reach: clampInt(evidence.signalCount, 0, Number.MAX_SAFE_INTEGER),
    impact: clampInt(evidence.severityTier, 0, IMPACT_MULTIPLIERS.length - 1),
    confidencePct: confidenceFromSources(evidence.corroboratingSources),
    effort: Math.max(1, clampInt(evidence.effortPoints, 1, Number.MAX_SAFE_INTEGER)),
  };
}

/** Resolve a stored item's inputs to the canonical RICE values (impact multiplier + confidence fraction). */
export function riceBreakdown(inputs: RiceItemInputs): RiceBreakdown {
  const reach = Math.max(0, inputs.reach);
  const tier = clampInt(inputs.impact, 0, IMPACT_MULTIPLIERS.length - 1);
  const impact = IMPACT_MULTIPLIERS[tier] ?? IMPACT_MULTIPLIERS[0];
  const confidence = Math.max(0, Math.min(100, inputs.confidencePct)) / 100;
  const effort = Math.max(1, inputs.effort);
  return { reach, impact, confidence, effort };
}

/** The canonical RICE score: (Reach × Impact × Confidence) / Effort. Never divides by zero. */
export function scoreRice(inputs: RiceItemInputs): number {
  const r = riceBreakdown(inputs);
  return (r.reach * r.impact * r.confidence) / r.effort;
}

/**
 * Rank the backlog highest-RICE first (the planning tick acts on the top item). **Pure**: descending by
 * score, ties broken by most-recent `createdAt` (the freshest evidence), then `id` for a total order.
 * Stable + non-mutating; assigns 1-based positions and carries the score + breakdown for display.
 */
export function rankBacklog(
  items: readonly BacklogItemRecord[],
  steering?: PlanningSteeringDirective | null,
): RankedBacklogItem[] {
  const maxBase = Math.max(0, ...items.map((item) => scoreRice(item)));
  const boostUnit = maxBase + 1;
  return [...items]
    .map((item) => {
      const baseScore = scoreRice(item);
      const steeringBoost = steeringMatchScore(item, steering) * boostUnit;
      return { item, score: baseScore + steeringBoost, baseScore, steeringBoost, rice: riceBreakdown(item) };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dt = b.item.createdAt.getTime() - a.item.createdAt.getTime();
      if (dt !== 0) return dt;
      return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
    })
    .map((r, i) => ({ ...r, position: i + 1 }));
}
