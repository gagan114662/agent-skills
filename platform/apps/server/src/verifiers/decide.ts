import type { VerifierCaps } from "./caps.js";
import type { VerifierOutcome, VerificationDecision } from "./types.js";

/**
 * The verifier decision (#106, ADR-0106 §2-3). **Pure + unit-tested**: given a pure {@link VerifierOutcome}
 * (or an un-measurable probe) and the caps, decide the single action the engine applies — `record_pass`,
 * `escalate`, or `skip`. The engine does the side effects (persist, enqueue the #13 approval); this makes
 * the choice. The "no silent pass" guarantee is encoded here: a measured failure can only ever resolve to
 * `escalate` (when escalation is enabled) — never to a quiet `record_pass`.
 */

/**
 * Decide what to do with a verification.
 *   1. errored (un-measurable probe)  → skip      (record `errored`; escalating would cry wolf)
 *   2. passed                          → record_pass
 *   3. failed + escalateOnFailure      → escalate  (record `failed` + open a #13 approval)
 *   4. failed + escalation off         → skip      (record `failed`; never silently "passed")
 */
export function decideVerification(
  outcome: VerifierOutcome | { errored: true },
  caps: VerifierCaps,
): VerificationDecision {
  if ("errored" in outcome && outcome.errored) {
    return { action: "skip", status: "errored", reason: "unmeasurable" };
  }
  const o = outcome as VerifierOutcome;
  if (o.passed) {
    return { action: "record_pass", status: "passed", reason: "outcome_passed" };
  }
  if (caps.escalateOnFailure) {
    return { action: "escalate", status: "failed", reason: "outcome_failed" };
  }
  return { action: "skip", status: "failed", reason: "outcome_failed_no_escalation" };
}
