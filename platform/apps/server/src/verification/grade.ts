import {
  isVerifiedMetric,
  type CheckObservation,
  type CheckResult,
  type DefinitionOfDone,
  type SuccessCriterion,
  type VerificationIdentity,
  type VerificationVerdict,
} from "./types.js";

/**
 * The pure deliverable grader (#191 AC #2-4). Given a definition of done, the independent grader's raw
 * observations, and the worker/grader identity, produce a {@link VerificationVerdict}: a per-criterion
 * pass/fail + confidence, the overall pass bit, and the structural invariants the premortem demands.
 * **No IO, no clock, no randomness** — the engine measures (spawns the independent grader) and persists;
 * this file only judges. That determinism is what makes "graded against a spec" a property of the code.
 *
 * The judging rules encode the premortem:
 *   - a `metric` criterion passes ONLY when its claim is backed by an external receipt (§2 — no fiction);
 *   - a `production` criterion passes ONLY on production-grounded evidence (§3 — the only final tier);
 *   - a `content` criterion passes on the grader's verdict;
 *   - a missing observation for a required criterion is a FAIL (it could not be verified);
 *   - the verdict is `passed` iff every REQUIRED check passed; confidence is the MIN over required checks.
 */

/** Grade one criterion against its observation (or its absence). Pure. */
function gradeCriterion(criterion: SuccessCriterion, obs: CheckObservation | undefined): CheckResult {
  // No observation ⇒ the grader could not verify it ⇒ fail with zero confidence + zero grounding.
  if (!obs) {
    return {
      criterionId: criterion.id,
      category: criterion.category,
      required: criterion.required,
      passed: false,
      confidence: 0,
      evidence: "no observation — could not verify",
      metricVerified: false,
      productionGrounded: false,
    };
  }

  const metricVerified = criterion.category === "metric" ? !!obs.metric && isVerifiedMetric(obs.metric) : false;

  let passed = obs.satisfied;
  // §2: an unverified (estimate) metric never clears a metric criterion, whatever the grader claims.
  if (criterion.category === "metric") passed = passed && metricVerified;
  // §3: a production criterion needs production-grounded evidence (a real spawn / click / canary).
  if (criterion.category === "production") passed = passed && obs.productionGrounded;

  return {
    criterionId: criterion.id,
    category: criterion.category,
    required: criterion.required,
    passed,
    confidence: clamp01(obs.confidence),
    evidence: obs.evidence,
    metricVerified,
    productionGrounded: obs.productionGrounded,
  };
}

/** Produce the full verdict for a deliverable. Pure. */
export function gradeDeliverable(
  dod: DefinitionOfDone,
  observations: CheckObservation[],
  identity: VerificationIdentity,
): VerificationVerdict {
  const byId = new Map(observations.map((o) => [o.criterionId, o]));
  const checks = dod.criteria.map((c) => gradeCriterion(c, byId.get(c.id)));

  const requiredChecks = checks.filter((c) => c.required);
  const passed = requiredChecks.every((c) => c.passed);
  // Confidence is the weakest required link — and 0 when there are no required checks (nothing proven).
  const confidence =
    requiredChecks.length > 0 ? Math.min(...requiredChecks.map((c) => c.confidence)) : 0;
  // Every REQUIRED production criterion must be production-grounded for the final-tier bit to be true.
  const requiredProduction = requiredChecks.filter((c) => c.category === "production");
  const productionGrounded =
    requiredProduction.length === 0 ? true : requiredProduction.every((c) => c.productionGrounded);

  return {
    passed,
    confidence,
    checks,
    workerMemberId: identity.workerMemberId,
    graderMemberId: identity.graderMemberId,
    independenceOk: identity.graderMemberId !== identity.workerMemberId,
    productionGrounded,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
