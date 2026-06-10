/**
 * The YC-bar rubric (#96) — the eight dimensions a fundable venture must clear, lifted from
 * `skills/idea-refine` (refinement-criteria.md: user value / differentiation / feasibility, sharpened
 * to a venture bar). **Pure**: scoring aggregation is deterministic so the gate's numbers are
 * unit-tested in isolation; the (non-deterministic) persona scoring that *produces* the per-dimension
 * numbers lives behind the `PersonaScorer` seam in `service.ts`.
 */

/** The eight YC-bar dimensions. Each persona scores every dimension 0–10. */
export const RUBRIC_DIMENSIONS = [
  "problemSeverity", // is the pain acute + frequent (painkiller, not vitamin)?
  "marketPath", // is there a credible ≥$1B market path?
  "novelInsight", // a non-obvious truth the team uniquely sees
  "defensibility", // durable moat — not copyable in a week
  "willingnessToPay", // evidence someone will actually pay
  "tenXVsIncumbents", // 10x better on a dimension users care about
  "distributionWedge", // a concrete narrowest-wedge path to users
  "whyNow", // why this is newly possible/urgent today
] as const;

export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

/** A single persona's view: a 0–10 score per rubric dimension. */
export type PersonaScorecard = Record<RubricDimension, number>;

/** Clamp to the valid per-dimension band. */
function clamp10(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/**
 * Combine the Advocate and the adversarial Reviewer per dimension, weighting the Reviewer higher so
 * the gate is conservative by construction (a skeptic's low score pulls the combined score down more
 * than the booster's high score pulls it up). `reviewerWeight` ∈ [0,1]; 0.6 is the default.
 */
export function combineDimensions(
  advocate: PersonaScorecard,
  reviewer: PersonaScorecard,
  reviewerWeight: number,
): PersonaScorecard {
  const w = Math.max(0, Math.min(1, reviewerWeight));
  const out = {} as PersonaScorecard;
  for (const d of RUBRIC_DIMENSIONS) {
    out[d] = clamp10((1 - w) * clamp10(advocate[d]) + w * clamp10(reviewer[d]));
  }
  return out;
}

/** Mean of the combined per-dimension scores, scaled to 0–100. */
export function aggregateScorecards(
  advocate: PersonaScorecard,
  reviewer: PersonaScorecard,
  reviewerWeight: number,
): number {
  const combined = combineDimensions(advocate, reviewer, reviewerWeight);
  const sum = RUBRIC_DIMENSIONS.reduce((acc, d) => acc + combined[d], 0);
  const mean = sum / RUBRIC_DIMENSIONS.length; // 0–10
  return Math.max(0, Math.min(100, mean * 10));
}

/** The dimension below which a combined score is "weak" and becomes an iteration angle. */
export const DEFAULT_WEAK_BELOW = 6;

/**
 * The weak dimensions — the structured gap list's angles (#96 step 4 ITERATE feedback). A dimension
 * whose combined score is below `weakBelow` is something the next pass must strengthen; the angle
 * string IS the dimension key, so the no-repeated-failed-angle check can compare angles across passes.
 */
export function gapAngles(
  advocate: PersonaScorecard,
  reviewer: PersonaScorecard,
  reviewerWeight: number,
  weakBelow: number = DEFAULT_WEAK_BELOW,
): RubricDimension[] {
  const combined = combineDimensions(advocate, reviewer, reviewerWeight);
  return RUBRIC_DIMENSIONS.filter((d) => combined[d] < weakBelow);
}
