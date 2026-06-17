/**
 * SkillOpt-Sleep adoption gate (#283, ADR-0283) — **pure**: the single decision that says whether a
 * candidate skill edit is allowed to be staged for owner adoption. This is the safety core of the loop and
 * it answers directly to the premortem (#200):
 *   - §2 self-reported metrics are fiction → an unverified reading is REJECTED, full stop. The only signal
 *     that can move a skill doc is an externally-verified receipt.
 *   - §3 verification must touch reality → the reading is a held-out replay measured on external receipts,
 *     and a too-small held-out set is rejected (no adoption on noise).
 * "Accepted only when a held-out validation gate STRICTLY improves" (the issue) is the rule encoded here:
 * the candidate must beat the baseline by a real margin, oriented by `higherIsBetter`. Deterministic ⇒
 * unit-testable; no IO.
 */
import type { ValidationReading } from "./contract.js";

/** Knobs for the gate. Defaults are conservative: ≥ 5 held-out samples, ≥ 5% relative improvement. */
export interface AdoptionGateOptions {
  /** Minimum held-out replay size for a reading to count (default 5). Below this ⇒ rejected as noise. */
  minSampleSize?: number;
  /** Minimum RELATIVE improvement over baseline to adopt (default 0.05 = 5%). Strict: a tie never adopts. */
  minImprovementRatio?: number;
}

/** The gate's verdict: whether to adopt, why, and the measured relative improvement (null when N/A). */
export interface AdoptionDecision {
  adopt: boolean;
  reason: string;
  /** Relative improvement of candidate over baseline (oriented by `higherIsBetter`); null if not computable. */
  improvementRatio: number | null;
}

/**
 * The signed improvement of `candidate` over `baseline`, oriented so a positive number always means
 * "better" regardless of metric direction. Pure + total.
 */
export function orientedImprovement(reading: ValidationReading): number {
  const delta = reading.candidate - reading.baseline;
  return reading.higherIsBetter ? delta : -delta;
}

/**
 * Relative improvement (fraction of |baseline|) so the margin is scale-free. When the baseline is 0 the
 * ratio is not computable from a fraction; we treat any strictly-positive oriented improvement as passing
 * the ratio test (a real gain from a zero baseline is still a gain), and a non-positive one as 0. Pure.
 */
export function improvementRatio(reading: ValidationReading): number {
  const improvement = orientedImprovement(reading);
  const denom = Math.abs(reading.baseline);
  if (denom === 0) return improvement > 0 ? Number.POSITIVE_INFINITY : 0;
  return improvement / denom;
}

/**
 * Decide whether a held-out validation reading clears the bar to stage a skill edit for adoption. The order
 * is fail-closed: an un-verified reading or a too-small held-out set is rejected before any improvement is
 * even considered — quality is judged only on external receipts, over a meaningful sample, by a strict
 * margin. Pure.
 */
export function decideAdoption(
  reading: ValidationReading,
  opts: AdoptionGateOptions = {},
): AdoptionDecision {
  const minSampleSize = opts.minSampleSize ?? 5;
  const minImprovementRatio = opts.minImprovementRatio ?? 0.05;

  // #200 §2: a self-reported metric can never drive adoption.
  if (!reading.externallyVerified) {
    return {
      adopt: false,
      reason: "reading is not externally verified — only third-party receipts can drive adoption (#200 §2)",
      improvementRatio: null,
    };
  }
  // #200 §3: don't adopt on a held-out set too small to mean anything.
  if (reading.sampleSize < minSampleSize) {
    return {
      adopt: false,
      reason: `held-out set too small (${reading.sampleSize} < ${minSampleSize}) — not enough signal to adopt`,
      improvementRatio: null,
    };
  }

  const improvement = orientedImprovement(reading);
  const ratio = improvementRatio(reading);
  // Strict improvement: a tie or regression never adopts.
  if (improvement <= 0) {
    return {
      adopt: false,
      reason: `candidate did not strictly improve the metric (Δ=${improvement.toFixed(4)})`,
      improvementRatio: ratio,
    };
  }
  if (ratio < minImprovementRatio) {
    return {
      adopt: false,
      reason: `improvement ${(ratio * 100).toFixed(1)}% below the ${(minImprovementRatio * 100).toFixed(
        1,
      )}% margin`,
      improvementRatio: ratio,
    };
  }
  return {
    adopt: true,
    reason: `candidate strictly improved ${reading.metric} by ${
      ratio === Number.POSITIVE_INFINITY ? "∞" : `${(ratio * 100).toFixed(1)}%`
    } on ${reading.sampleSize} externally-verified samples`,
    improvementRatio: ratio,
  };
}
