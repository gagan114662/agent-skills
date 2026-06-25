import { loadConfig } from "../config/loader.js";
import { makeRedactor } from "../runtime/redact.js";
import { resolveVerificationCaps } from "./caps.js";
import {
  VerificationEngine,
  type IndependentGrader,
  type VerificationApprovalSink,
  type WorkerFeedback,
} from "./engine.js";
import type { VerificationVerdict, DefinitionOfDone } from "./types.js";
import { definitionStore, verdictStore } from "../db/repositories/verification.js";
import { listLiveSessions } from "../db/repositories/agent-sessions.js";
import { getControls } from "../db/repositories/autonomy.js";
import { createRequest } from "../db/repositories/approvals.js";
import type { SessionLogger } from "../runtime/manager.js";
import { createDefaultIndependentGrader } from "./content-grader.js";

/**
 * Production wiring for the Deliverable Verification Layer (#191, ADR-0191). Default-OFF
 * (`verification.enabled`), so decorating it changes nothing until an operator opts in (owner workspace
 * first). Every seam is real: the stores are the `verification_criteria` / `verification_verdicts` repos,
 * the approval/escalation sink is the #13 queue, and the kill switch is the #17 control.
 *
 * The default INDEPENDENT grader (#854) is deterministic and local: it checks the named content criteria it
 * can actually verify (originality against supplied sources, brand/fact safety against the brand-fact gate,
 * and obvious private-data leaks) and fails closed for unknown criteria. A deployment may still replace it
 * with a separate #59 verifier session for model/browser-backed checks.
 */

/** Build the #13 proof payload shared by the approval card + the escalation (AC #4 — receipts on the card). */
function proofPayload(dod: DefinitionOfDone, verdict: VerificationVerdict, redact: (t: string) => string) {
  const passedCount = verdict.checks.filter((c) => c.passed).length;
  return {
    deliverableKind: dod.deliverableKind,
    reversibility: dod.reversibility,
    passed: verdict.passed,
    confidence: verdict.confidence,
    independenceOk: verdict.independenceOk,
    productionGrounded: verdict.productionGrounded,
    checksPassed: passedCount,
    checksTotal: verdict.checks.length,
    criteria: dod.criteria,
    checks: verdict.checks.map((c) => ({ ...c, evidence: redact(c.evidence) })),
  };
}

/**
 * The #13 sink. `requestApproval` opens a card showing the criteria + per-check pass/fail + confidence
 * (proof, not a bare "ready"); `escalate` opens the repeated-failure / non-independent card. Both require
 * a real requester member (#13 FK) resolved from a live session in the workspace.
 */
function makeApprovalSink(redact: (t: string) => string): VerificationApprovalSink {
  async function requesterFor(workspaceId: string): Promise<string> {
    const live = await listLiveSessions();
    const session = live.find((s) => s.workspaceId === workspaceId);
    if (!session) throw new Error("verification: no requester member available");
    return session.agentMemberId;
  }
  return {
    requestApproval: async ({ workspaceId, deliverable, dod, verdict, reason }) => {
      const requesterMemberId = await requesterFor(workspaceId);
      const passed = verdict.checks.filter((c) => c.passed).length;
      const req = await createRequest({
        workspaceId,
        requesterMemberId,
        actionType: "verification.review",
        payload: { deliverableRef: deliverable.deliverableRef, ...proofPayload(dod, verdict, redact) },
        amount: null,
        summary: redact(
          `Verification: ${dod.deliverableKind} "${deliverable.deliverableRef}" — ` +
            `${passed}/${verdict.checks.length} checks passed, confidence ${verdict.confidence.toFixed(2)}, ` +
            `${dod.reversibility}. ${reason}`,
        ),
        status: "pending",
        expiresAt: null,
        events: [{ type: "requested", detail: { deliverableRef: deliverable.deliverableRef } }],
      });
      return { id: req.id };
    },
    escalate: async ({ workspaceId, deliverable, dod, verdict, reason }) => {
      const requesterMemberId = await requesterFor(workspaceId);
      const req = await createRequest({
        workspaceId,
        requesterMemberId,
        actionType: "verification.escalated",
        payload: { deliverableRef: deliverable.deliverableRef, ...proofPayload(dod, verdict, redact) },
        amount: null,
        summary: redact(
          `Verification ESCALATED: ${dod.deliverableKind} "${deliverable.deliverableRef}" — ${reason}. ` +
            `A human must decide (never silently ships).`,
        ),
        status: "pending",
        expiresAt: null,
        events: [{ type: "requested", detail: { deliverableRef: deliverable.deliverableRef } }],
      });
      return { id: req.id };
    },
  };
}

/**
 * The default fail→fix feedback. It records the specific failures (redacted) to the log so they are
 * visible against the worker's session; re-driving the worker session automatically is an additive seam
 * (steer the live #53 session) a deployment can supply.
 */
function makeWorkerFeedback(logger: SessionLogger, redact: (t: string) => string): WorkerFeedback {
  return {
    returnToWorker: async ({ workspaceId, deliverable, failures, retryCount }) => {
      logger.warn(
        {
          workspaceId,
          deliverableRef: deliverable.deliverableRef,
          retryCount,
          failures: failures.map((f) => ({ criterionId: f.criterionId, evidence: redact(f.evidence) })),
        },
        "verification returned deliverable to worker with specific failures (fail→fix)",
      );
    },
  };
}

/** Build the production VerificationEngine. Decorated on `app`; invoked at deliverable chokepoints. */
export function createDefaultVerificationEngine(
  logger: SessionLogger,
  grader: IndependentGrader = createDefaultIndependentGrader(),
): VerificationEngine {
  const redactor = makeRedactor({});
  const redact = (text: string) => redactor(text);
  return new VerificationEngine({
    definitions: definitionStore,
    verdicts: verdictStore,
    grader,
    approvals: makeApprovalSink(redact),
    feedback: makeWorkerFeedback(logger, redact),
    caps: (workspaceId) => resolveVerificationCaps(loadConfig(workspaceId).verification),
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    redact,
    logger,
  });
}
