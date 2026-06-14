import type { ValidationReceipt, ValidationScorecard, ValidationVerdict } from "./types.js";

/**
 * Validation-experiment math for the Venture Factory (#187 AC2). **Pure** — three responsibilities, each
 * a fast unit test:
 *   - `decideValidationSpend`: a HARD budget cap. The smoke test (landing + waitlist/preorder via the
 *     #153 marketing-site patterns) may never spend past `budgetCapCents`. The cap is checked before
 *     every charge, so a runaway experiment is impossible.
 *   - `scoreFromReceipts`: builds the scorecard from EXTERNAL receipts ONLY (premortem #200 FM#2 —
 *     self-reported metrics are fiction). Signups and ad-spend come in as signed/third-party receipts;
 *     CAC and the 0–100 score are DERIVED and carry the `UNVERIFIED` label.
 *   - `decideValidationOutcome`: PROMOTE / KILL / INCONCLUSIVE from the scorecard + thresholds. The
 *     derived score never decides alone — PROMOTE requires a real external signup floor AND a CAC ceiling.
 */

export interface ValidationSpendInput {
  /** The hard cap (cents) for the whole experiment. */
  budgetCapCents: number;
  /** Cents already spent on this experiment. */
  spentCents: number;
  /** The next charge being requested. */
  requestedCents: number;
}

export interface ValidationSpendDecision {
  allowed: boolean;
  /** Cents left under the cap after this decision (never negative). */
  remainingCents: number;
  reason: string;
}

/** Allow a charge iff it keeps total spend at/under the hard cap. Total and pure. */
export function decideValidationSpend(input: ValidationSpendInput): ValidationSpendDecision {
  const remainingBefore = Math.max(0, input.budgetCapCents - input.spentCents);
  if (input.requestedCents <= 0) {
    return { allowed: false, reason: "non-positive charge", remainingCents: remainingBefore };
  }
  if (input.spentCents + input.requestedCents > input.budgetCapCents) {
    return {
      allowed: false,
      remainingCents: remainingBefore,
      reason: `validation budget cap reached: ${input.spentCents}+${input.requestedCents} > ${input.budgetCapCents}¢`,
    };
  }
  return {
    allowed: true,
    remainingCents: input.budgetCapCents - input.spentCents - input.requestedCents,
    reason: "within validation budget",
  };
}

/**
 * Build the scorecard from external receipts. `signupScore` is the bounded signal — each external
 * signup is worth `pointsPerSignup` points up to 100. CAC is spend ÷ signups (UNVERIFIED, null when
 * zero signups). The score is the signup signal alone; spend never inflates confidence.
 */
export function scoreFromReceipts(
  receipts: ValidationReceipt[],
  opts: { pointsPerSignup: number },
): ValidationScorecard {
  let signups = 0;
  let spentCents = 0;
  for (const r of receipts) {
    if (r.kind === "signup") signups += 1;
    else if (r.kind === "ad_spend") spentCents += Math.max(0, r.amountCents);
  }
  const cacCents = signups > 0 ? Math.round(spentCents / signups) : null;
  const score = Math.max(0, Math.min(100, Math.round(signups * opts.pointsPerSignup)));
  return { signups, spentCents, cacCents, score, estimateLabel: "UNVERIFIED" };
}

export interface ValidationOutcomeThresholds {
  /** Minimum EXTERNAL signups to PROMOTE (a real demand floor, not a derived number). */
  minSignups: number;
  /** Maximum acceptable CAC (cents) to PROMOTE; above it, the unit economics fail. */
  maxCacCents: number;
  /** Signups at/below which the experiment is a clear KILL. */
  killSignups: number;
}

export interface ValidationOutcomeInput {
  scorecard: ValidationScorecard;
  /** True when the experiment hit its hard budget cap with no charge left. */
  budgetExhausted: boolean;
  thresholds: ValidationOutcomeThresholds;
}

/**
 * Decide the experiment's fate. Priority: a clear-failure floor → KILL; a real signup floor under a
 * CAC ceiling → PROMOTE; otherwise INCONCLUSIVE (budget-exhausted ⇒ escalate, else keep validating).
 * Pure — and PROMOTE always rests on an EXTERNAL signup count, never the derived score alone (FM#2).
 */
export function decideValidationOutcome(input: ValidationOutcomeInput): {
  verdict: ValidationVerdict;
  reasoning: string;
} {
  const { scorecard: s, thresholds: t } = input;

  if (s.signups <= t.killSignups) {
    return { verdict: "KILL", reasoning: `only ${s.signups} external signup(s) ≤ kill floor ${t.killSignups}` };
  }
  // PROMOTE rests on an EXTERNAL signup floor under a CAC ceiling. With signups present, CAC is never
  // null (it is 0 for fully-organic acquisition), so a real demand floor at zero/low CAC promotes.
  if (s.signups >= t.minSignups && s.cacCents !== null && s.cacCents <= t.maxCacCents) {
    return {
      verdict: "PROMOTE",
      reasoning: `${s.signups} external signups at CAC ${s.cacCents}¢ ≤ ${t.maxCacCents}¢ — real demand`,
    };
  }
  if (input.budgetExhausted) {
    return {
      verdict: "INCONCLUSIVE",
      reasoning: `budget exhausted with ${s.signups} signups (CAC ${s.cacCents ?? "n/a"}¢) — escalate to a human`,
    };
  }
  return {
    verdict: "INCONCLUSIVE",
    reasoning: `${s.signups} signups so far — keep validating within budget`,
  };
}
