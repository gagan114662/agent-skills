import {
  combineDimensions,
  RUBRIC_DIMENSIONS,
  type PersonaScorecard,
  type RubricDimension,
} from "../venture/rubric.js";
import type { DemandSignalClass, ExternalDemandEvidence } from "./provenance.js";

/**
 * The #96 ↔ #101 seam (pure): turn **externally-attributed** demand evidence into the scorecard's demand
 * dimension, *replacing* the synthetic persona number when real evidence is present. The input type is the
 * branded {@link ExternalDemandEvidence} — self-generated (circular) evidence is not assignable, so this
 * function can never be fed a model's own willingness-to-pay guess.
 */

/** The single rubric dimension that is demand (the circular one #101 de-circularizes). */
export const DEMAND_DIMENSION: RubricDimension = "willingnessToPay";

/** 0–10 demand weight per signal class — a real `paid` is maximal; a bare visit is faint. */
const DEMAND_WEIGHT: Record<DemandSignalClass, number> = {
  visit: 2,
  cta_click: 4,
  waitlist: 5,
  checkout_started: 7,
  paid: 10,
};

function clamp10(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/**
 * Reduce external demand evidence to a 0–10 demand-dimension score. The **strongest signal class present
 * dominates** (one real payment outweighs any number of visits) — there is no volume inflation, keeping
 * the score honest about the apex action a stranger actually took. Empty evidence → 0.
 */
export function demandScoreFromExternal(evidence: ExternalDemandEvidence[]): number {
  if (evidence.length === 0) return 0;
  return clamp10(Math.max(...evidence.map((e) => DEMAND_WEIGHT[e.signalClass])));
}

/** Return a copy of the combined scorecard with only the demand dimension replaced by `demandScore`. */
export function overlayDemandDimension(
  combined: PersonaScorecard,
  demandScore: number,
): PersonaScorecard {
  return { ...combined, [DEMAND_DIMENSION]: clamp10(demandScore) };
}

/**
 * Aggregate the two personas to a 0–100 score, overlaying the real demand score onto the demand dimension
 * when present. With `demandScore === null` this is **byte-for-byte** the plain `aggregateScorecards`
 * (default-OFF: no external evidence ⇒ unchanged behavior).
 */
export function aggregateWithDemandOverlay(
  advocate: PersonaScorecard,
  reviewer: PersonaScorecard,
  reviewerWeight: number,
  demandScore: number | null,
): number {
  const base = combineDimensions(advocate, reviewer, reviewerWeight);
  const combined = demandScore === null ? base : overlayDemandDimension(base, demandScore);
  const sum = RUBRIC_DIMENSIONS.reduce((acc, d) => acc + combined[d], 0);
  const mean = sum / RUBRIC_DIMENSIONS.length; // 0–10
  return Math.max(0, Math.min(100, mean * 10));
}
