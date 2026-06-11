import type { Verdict } from "../venture/types.js";
import type { ConstitutionViolation, DecisionStage, VentureSegment } from "./types.js";

/**
 * Article I — the love paradigm (#146, ADR-0146). **Pure + unit-tested.** A B2B venture cannot pass
 * FUND on a persuasive pitch alone; it needs evidence that real, unaffiliated people want it badly
 * enough to act. This is the ONE check that changes a verdict — and it does so by **escalating to a
 * human** (FUND → ESCALATE), never by silently correcting. It bites only when:
 *   constitution enabled, AND the base verdict is FUND, AND the segment is B2B, AND the venture has
 *   fewer than `minSignals` distinct unaffiliated paying-intent signals.
 */
export interface LoveGateInput {
  enabled: boolean;
  /** The base verdict produced by the pure `decideVenture`. */
  verdict: Verdict;
  segment: VentureSegment | null;
  /** Distinct unaffiliated (externally-attributed) paying-intent signals for the idea. */
  unaffiliatedPayingIntentSignals: number;
  /** The Article I threshold (default 10). */
  minSignals: number;
  /** The deciding stage (for the violation record) — normally "FUND". */
  stage: DecisionStage;
}

export interface LoveGateResult {
  /** True ⇒ the caller downgrades FUND → ESCALATE (routes the decision to a human). */
  gated: boolean;
  /** The recorded violation when gated, else null. */
  violation: ConstitutionViolation | null;
}

export function evaluateLoveGate(input: LoveGateInput): LoveGateResult {
  const pass: LoveGateResult = { gated: false, violation: null };
  if (!input.enabled) return pass;
  if (input.verdict !== "FUND") return pass;
  if (input.segment !== "b2b") return pass;
  if (input.unaffiliatedPayingIntentSignals >= input.minSignals) return pass;

  return {
    gated: true,
    violation: {
      article: "I",
      code: "love_paradigm_unmet",
      severity: "block",
      stage: input.stage,
      message:
        `Article I (love paradigm): a B2B venture cannot pass FUND without ≥${input.minSignals} ` +
        `unaffiliated paying-intent signals — found ${input.unaffiliatedPayingIntentSignals}. ` +
        `Escalating to a human instead of funding.`,
    },
  };
}
