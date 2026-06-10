import type { Verdict, VentureThresholds } from "./types.js";
import { hasNovelAngle, maxIterationsReached } from "./guards.js";

/**
 * The venture decision (#96 step 4 DECIDE). **Pure**: given a scorecard's aggregate score, the loop
 * state (which pass this is, what angles the next pass would pursue, which angles already failed), and
 * config thresholds, decide FUND / KILL / ESCALATE / ITERATE. The single source of truth for the
 * gate — every required path is a unit test against this function (the #17 `decide`/`guards` split).
 *
 * Priority is deliberate (hard verdicts before loop state, like `scale/decide.ts`):
 *   1. score ≥ fund                        → FUND
 *   2. score ≤ kill                        → KILL
 *   3. fund-band ≤ score < fund            → ESCALATE  (borderline near-miss → human judgment)
 *   4. otherwise (mid-band) it WOULD iterate, but terminate first:
 *        - the dollar budget is exhausted  → ESCALATE  (no more spend on this idea)
 *        - iteration budget exhausted      → ESCALATE  (max-iteration exit)
 *        - no novel angle left to pursue   → ESCALATE  (no-repeated-failed-angle)
 *        - else                            → ITERATE
 *
 * Budget is checked only in the mid-band: a FUND-worthy score still FUNDs even if spend ran out (the
 * work is done), but we never spend MORE iterating once the dollar ceiling is hit.
 */
export interface VentureDecisionInput {
  /** The scorecard's adversarially-weighted aggregate, 0–100. */
  score: number;
  /** 1-based index of the pass that produced `score`. */
  iteration: number;
  /** Angles (rubric dimensions) the next pass's gap list would pursue. */
  proposedAngles: string[];
  /** Angles already attempted in prior passes (never re-run a failed angle). */
  failedAngles: string[];
  /** The evaluation has met/passed its dollar budget (tenant-usage cap) — stop spending. */
  budgetExhausted: boolean;
  thresholds: VentureThresholds;
}

export interface VentureDecision {
  verdict: Verdict;
  reasoning: string;
}

export function decideVenture(input: VentureDecisionInput): VentureDecision {
  const { score, iteration, proposedAngles, failedAngles, budgetExhausted, thresholds } = input;
  const { fund, kill, escalateBand, maxIterations } = thresholds;

  if (score >= fund) {
    return { verdict: "FUND", reasoning: `score ${score} ≥ fund threshold ${fund}` };
  }
  if (score <= kill) {
    return { verdict: "KILL", reasoning: `score ${score} ≤ kill threshold ${kill}` };
  }
  if (score >= fund - escalateBand) {
    return {
      verdict: "ESCALATE",
      reasoning: `borderline: score ${score} within ${escalateBand} of fund line ${fund} — human judgment`,
    };
  }

  // Mid-band: would iterate, but apply the termination conditions first.
  if (budgetExhausted) {
    return {
      verdict: "ESCALATE",
      reasoning: `dollar budget exhausted — escalating to a human instead of spending more`,
    };
  }
  if (maxIterationsReached(iteration, maxIterations)) {
    return {
      verdict: "ESCALATE",
      reasoning: `iteration budget exhausted (${iteration}/${maxIterations}) — escalating to a human`,
    };
  }
  if (!hasNovelAngle(proposedAngles, failedAngles)) {
    return {
      verdict: "ESCALATE",
      reasoning: `no novel angle left (every gap repeats a failed angle) — escalating to a human`,
    };
  }
  return {
    verdict: "ITERATE",
    reasoning: `score ${score} in the improvable mid-band; ${proposedAngles.length} angle(s) to pursue`,
  };
}
