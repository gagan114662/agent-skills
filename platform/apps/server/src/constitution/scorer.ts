import type { ConstitutionCaps } from "./caps.js";
import type { ConstitutionDecisionContext, ConstitutionReport, ConstitutionViolation } from "./types.js";

/**
 * The constitution scorer (#146, ADR-0146). **Pure + deterministic + unit-tested.** Scores a single
 * venture SOURCE / FUND / KILL decision against the Articles and returns the violations it finds. It
 * never changes a verdict — the caller records the violations (flag + escalate). The ONE verdict-
 * changing check (Article I love-gate) is a separate module; the scorer ALSO emits the Article I
 * violation so the recorded set is complete regardless of how the caller wires the gate.
 *
 * Checks (only the ones with deterministic, context-available signals):
 *   - FUND, B2B, below love threshold        → I   love_paradigm_unmet            (block)
 *   - FUND with no externally-attributed demand → V   funded_on_synthetic_demand     (medium)
 *   - FUND with no realized payment          → VIII funded_without_realized_payment (low)
 *   - SOURCE, B2B, no demand evidence yet    → I   b2b_sourced_without_demand      (low, early warning)
 *   - KILL                                   → compliant (Article II honoured) — no violations
 */
export function scoreDecision(
  ctx: ConstitutionDecisionContext,
  caps: ConstitutionCaps,
): ConstitutionReport {
  const violations: ConstitutionViolation[] = [];
  if (!caps.enabled) return { violations };

  if (ctx.stage === "FUND") {
    if (ctx.segment === "b2b" && ctx.unaffiliatedPayingIntentSignals < caps.loveMinSignals) {
      violations.push({
        article: "I",
        code: "love_paradigm_unmet",
        severity: "block",
        stage: "FUND",
        message:
          `Article I: B2B venture FUNDed with ${ctx.unaffiliatedPayingIntentSignals} ` +
          `unaffiliated paying-intent signals (< ${caps.loveMinSignals}).`,
      });
    }
    if (!ctx.externalDemandPresent) {
      violations.push({
        article: "V",
        code: "funded_on_synthetic_demand",
        severity: "medium",
        stage: "FUND",
        message:
          "Article V: FUND made with no externally-attributed demand evidence — the demand score is " +
          "synthetic (don't fool yourself).",
      });
    }
    if (!ctx.paidSignalPresent) {
      violations.push({
        article: "VIII",
        code: "funded_without_realized_payment",
        severity: "low",
        stage: "FUND",
        message: "Article VIII: FUND made with no realized willingness-to-pay (no `paid` signal).",
      });
    }
  }

  if (ctx.stage === "SOURCE" && ctx.segment === "b2b" && !ctx.externalDemandPresent) {
    violations.push({
      article: "I",
      code: "b2b_sourced_without_demand",
      severity: "low",
      stage: "SOURCE",
      message:
        "Article I (early warning): B2B venture sourced with no demand evidence yet — unaffiliated " +
        "paying-intent evidence will be required to FUND.",
    });
  }

  return { violations };
}
