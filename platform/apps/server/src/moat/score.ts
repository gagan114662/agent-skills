/**
 * Moat scoring (#103, ADR-0103). **Pure**: given a venture's accruals and the per-dimension weights,
 * produce a deterministic 0–100 moat score; given the accrual timestamps and a clock instant, decide
 * whether the venture has stagnated. No IO and no clock of its own — the instant is passed in — so the
 * whole module is unit-tested in isolation (the #96/#71/#117 pure-core pattern). The (non-deterministic)
 * collection of accruals lives behind the repo seam in `service.ts`.
 */

/** The four moat dimensions from premortem #4 — proprietary data, switching costs, distribution
 * lock-in, and the platform's own accumulated evals/skills. */
export const MOAT_DIMENSIONS = [
  "proprietaryData", // data that accumulates with use and a competitor cannot rebuild
  "switchingCosts", // workflow embedding / dependent state that makes leaving expensive
  "distributionLockIn", // network/marketplace liquidity / distribution that self-reinforces
  "accumulatedEvals", // the fleet's own compounding evals + reusable skills
] as const;

export type MoatDimension = (typeof MOAT_DIMENSIONS)[number];

/** Per-dimension weights when combining the dimension subscores into the aggregate. */
export type MoatWeights = Record<MoatDimension, number>;

/** A scored venture moat: per-dimension subscores (0–10) + the weighted-mean aggregate (0–100). */
export interface MoatScore {
  dimensions: Record<MoatDimension, number>;
  score: number;
}

/** Equal weighting (every dimension counts the same) — the resolver's default. */
export function defaultMoatWeights(): MoatWeights {
  return Object.fromEntries(MOAT_DIMENSIONS.map((d) => [d, 1])) as MoatWeights;
}

/**
 * The magnitude at which a single dimension reaches half of its max subscore (5/10). The curve is
 * saturating with diminishing returns: the first units of accrual move the needle most, and a runaway
 * magnitude can never exceed 10 — so a moat is built by *sustained breadth*, not one big dump.
 */
export const SUBSCORE_HALF_SATURATION = 10;

/** A saturating 0–10 subscore for a dimension's total magnitude: `10·m/(m+k)`. Monotonic, asymptotic
 * to 10, with diminishing returns. `magnitudeSum` ≤ 0 ⇒ 0. */
export function dimensionSubscore(magnitudeSum: number): number {
  const m = Math.max(0, magnitudeSum);
  if (m === 0) return 0;
  return (10 * m) / (m + SUBSCORE_HALF_SATURATION);
}

/** Sum magnitudes per dimension, subscore each, then take the weight-clamped weighted mean × 10 →
 * 0–100. All weights ≤ 0 ⇒ 0 (no division by zero). Pure + deterministic. */
export function scoreMoat(
  accruals: { dimension: MoatDimension; magnitude: number }[],
  weights: MoatWeights,
): MoatScore {
  const totals = Object.fromEntries(MOAT_DIMENSIONS.map((d) => [d, 0])) as Record<
    MoatDimension,
    number
  >;
  for (const a of accruals) totals[a.dimension] += Math.max(0, a.magnitude);

  const dimensions = Object.fromEntries(
    MOAT_DIMENSIONS.map((d) => [d, dimensionSubscore(totals[d])]),
  ) as Record<MoatDimension, number>;

  let weightedSum = 0;
  let weightTotal = 0;
  for (const d of MOAT_DIMENSIONS) {
    const w = Math.max(0, weights[d]);
    weightedSum += w * dimensions[d];
    weightTotal += w;
  }
  const mean = weightTotal > 0 ? weightedSum / weightTotal : 0; // 0–10
  return { dimensions, score: Math.max(0, Math.min(100, mean * 10)) };
}

/** The window-stagnation verdict for one venture. */
export interface AccrualWindowAssessment {
  /** True when no accrual landed strictly inside `(nowMs - windowMs, nowMs]`. */
  stagnant: boolean;
  /** Count of accruals inside the window. */
  accrualsInWindow: number;
  /** Epoch ms of the most recent accrual overall (even if outside the window), or null when empty. */
  lastAccrualAtMs: number | null;
}

/** Decide whether a venture's moat has stopped compounding: stagnant ⇔ zero accrual in the trailing
 * window. The window edge is strict (an accrual exactly `windowMs` old is *outside*). */
export function assessAccrualWindow(input: {
  entries: { createdAtMs: number }[];
  nowMs: number;
  windowMs: number;
}): AccrualWindowAssessment {
  const cutoff = input.nowMs - input.windowMs;
  const accrualsInWindow = input.entries.filter((e) => e.createdAtMs > cutoff).length;
  const lastAccrualAtMs = input.entries.length
    ? input.entries.reduce((max, e) => Math.max(max, e.createdAtMs), -Infinity)
    : null;
  return { stagnant: accrualsInWindow === 0, accrualsInWindow, lastAccrualAtMs };
}
