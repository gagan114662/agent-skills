import type { VerificationCaps } from "./caps.js";
import type { DefinitionOfDone, VerificationDecision, VerificationVerdict } from "./types.js";

/**
 * The verification decision (#191 AC #2-4, premortem #200 §2-4). **Pure + unit-tested**: given the
 * independent grader's {@link VerificationVerdict}, the {@link DefinitionOfDone} (carrying the
 * reversibility class), the caps, and how many times the worker has already retried, decide the single
 * action the engine applies. The engine does the side effects (persist, open the #13 card, hand the
 * failures back to the worker); this makes the choice.
 *
 * The invariants are encoded here, not hoped for:
 *   - a verdict the worker graded itself can ONLY escalate (never proceeds) — AC #2;
 *   - a failed verification returns to the worker, then escalates after the retry budget — AC #3;
 *   - an IRREVERSIBLE deliverable is NEVER auto-sent — it is always human-gated (premortem §4);
 *   - the production-grounded tier is required where it applies before a pass can clear (premortem §3);
 *   - a low-confidence pass never auto-sends — a human looks (premortem §2, "estimates don't drive").
 */

/** Whether a deliverable requires the production-grounded final tier (premortem §3). */
function needsProduction(dod: DefinitionOfDone): boolean {
  return (
    dod.deliverableKind === "venture_deploy" ||
    dod.reversibility === "irreversible" ||
    dod.criteria.some((c) => c.category === "production")
  );
}

export function decideVerification(
  verdict: VerificationVerdict,
  dod: DefinitionOfDone,
  caps: VerificationCaps,
  retryCount: number,
): VerificationDecision {
  // 1. The worker never grades its own homework — a non-independent verdict can only escalate (AC #2).
  if (!verdict.independenceOk) {
    return { action: "escalate", reason: "verifier was not independent of the worker — cannot trust the verdict" };
  }

  // 2. A failed verification goes back to the worker with the failures, then escalates (AC #3).
  if (!verdict.passed) {
    return retryCount < caps.maxRetries
      ? { action: "return_to_worker", reason: "verification failed — returning the specific failures to the worker" }
      : { action: "escalate", reason: `verification still failing after ${retryCount} retries — escalating to the decision queue` };
  }

  // 3. The production-grounded tier (real spawn / click-through / canary) is required where it applies.
  if (caps.requireProductionGrounding && needsProduction(dod) && !verdict.productionGrounded) {
    return retryCount < caps.maxRetries
      ? { action: "return_to_worker", reason: "passed on content but production-grounded evidence is missing — returning to the worker" }
      : { action: "escalate", reason: `production grounding unmet after ${retryCount} retries — escalating` };
  }

  // 4. An irreversible deliverable is ALWAYS human-gated — never auto-sent (premortem §4).
  if (dod.reversibility === "irreversible") {
    return { action: "request_approval", reason: "irreversible deliverable — a human must approve (never post-hoc review)" };
  }

  // 5. A low-confidence pass never auto-sends — a human takes a look (premortem §2).
  if (verdict.confidence < caps.minConfidence) {
    return { action: "request_approval", reason: `verified but confidence ${verdict.confidence.toFixed(2)} < ${caps.minConfidence} — human review` };
  }

  // 6. A verified REVERSIBLE deliverable may auto-proceed only when the deployment opted in. `cheap`
  //    (reversible-with-cost) never auto-proceeds.
  if (dod.reversibility === "reversible" && caps.autoSendReversible) {
    return { action: "auto_proceed", reason: "verified, reversible, and auto-send is enabled — proceeding" };
  }

  // 7. Default: a verified deliverable still waits for a human approval (receipts on the card).
  return { action: "request_approval", reason: "verified — awaiting human approval" };
}
