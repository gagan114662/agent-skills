import type { SessionLogger } from "../runtime/manager.js";
import type { VerificationCaps } from "./caps.js";
import { deriveDefinitionOfDone, validateDefinitionOfDone } from "./criteria.js";
import { decideVerification } from "./decide.js";
import { gradeDeliverable } from "./grade.js";
import {
  type CheckObservation,
  type CheckResult,
  type DefinitionOfDone,
  type DefinitionOfDoneRecord,
  type DeliverableKind,
  type ReversibilityClass,
  type VerificationDecision,
  type VerificationVerdict,
  type VerificationVerdictRecord,
} from "./types.js";

/**
 * The Deliverable Verification Layer engine (#191, ADR-0191) — the IO orchestrator for "nothing ships
 * unverified". The decision is pure (`criteria` / `grade` / `decide`); every side effect is a seam here:
 *
 *   - `defineDone()` derives the success criteria from a brief BEFORE the work runs and persists them
 *     (AC #1 — define done before doing).
 *   - `verify()` runs a SEPARATE grader (the independent-verifier seam — production spawns a #59 subagent),
 *     judges its observations against the definition (pure), persists the verdict, and applies the single
 *     decided action: open a #13 approval card with the proof attached, hand the specific failures back
 *     to the worker (fail→fix), escalate after the retry budget, or — only for a verified, reversible,
 *     opted-in deliverable — auto-proceed. The worker never grades its own homework; that invariant lives
 *     in the pure grader + decision and is enforced here by refusing to trust a non-independent verdict.
 *
 * Gating mirrors the other loops: the config `enabled` flag, then the #17 kill switch, then (for any
 * background sweep) the #99 maintenance flag.
 */

// ---- seams -------------------------------------------------------------------------------------

/** Persistence for the definition of done (real impl wraps the `verification_criteria` repo). */
export interface DefinitionStore {
  record(input: {
    workspaceId: string;
    deliverableRef: string;
    deliverableKind: DeliverableKind;
    reversibility: ReversibilityClass;
    criteria: DefinitionOfDone["criteria"];
    briefDigest: string;
    now: Date;
  }): Promise<DefinitionOfDoneRecord>;
  latest(workspaceId: string, deliverableRef: string): Promise<DefinitionOfDoneRecord | null>;
}

/** Persistence for verdicts (real impl wraps the `verification_verdicts` repo). */
export interface VerdictStore {
  record(input: {
    workspaceId: string;
    deliverableRef: string;
    deliverableKind: DeliverableKind;
    status: VerificationDecision["action"];
    passed: boolean;
    confidence: number;
    reversibility: ReversibilityClass;
    independenceOk: boolean;
    productionGrounded: boolean;
    retryCount: number;
    checks: CheckResult[];
    workerMemberId: string | null;
    graderMemberId: string | null;
    approvalRequestId: string | null;
    reason: string;
    now: Date;
  }): Promise<VerificationVerdictRecord>;
  /** How many times this deliverable has already been returned to the worker (the fail→fix counter). */
  countReturns(workspaceId: string, deliverableRef: string): Promise<number>;
}

/** The deliverable handed to the verifier — its content + who produced it. */
export interface Deliverable {
  workspaceId: string;
  deliverableRef: string;
  deliverableKind: DeliverableKind;
  /** The member that produced it (the worker). The grader MUST differ. */
  workerMemberId: string;
  /** The content to grade (free-form; redacted in evidence, never persisted raw). */
  content: string;
  /** Owner-configured brand voice or campaign voice direction, used by the default content grader. */
  brandVoice?: string;
  /** Claims the brand has pre-approved; used by the default brand/fact gate. */
  brandClaims?: string[];
  /** Known source texts/URLs to compare against for originality checks. */
  originalitySources?: Array<{ id: string; text: string }>;
}

/**
 * The independent verifier seam (#191 AC #2). A SEPARATE grader judges the deliverable against the
 * definition of done and returns its identity + per-criterion observations. Production spawns a #59
 * subagent under a different member id; tests inject a deterministic grader. The engine refuses to trust
 * a verdict whose `graderMemberId` equals the worker's.
 */
export interface IndependentGrader {
  grade(input: {
    deliverable: Deliverable;
    dod: DefinitionOfDone;
  }): Promise<{ graderMemberId: string; observations: CheckObservation[] }>;
}

/** The #13 sink — open an approval card carrying the proof, or escalate a repeated failure. */
export interface VerificationApprovalSink {
  requestApproval(input: {
    workspaceId: string;
    deliverable: Deliverable;
    dod: DefinitionOfDone;
    verdict: VerificationVerdict;
    reason: string;
  }): Promise<{ id: string }>;
  escalate(input: {
    workspaceId: string;
    deliverable: Deliverable;
    dod: DefinitionOfDone;
    verdict: VerificationVerdict;
    reason: string;
  }): Promise<{ id: string }>;
}

/** Hand the SPECIFIC failures back to the worker for a fix (#191 AC #3). Best-effort. */
export interface WorkerFeedback {
  returnToWorker(input: {
    workspaceId: string;
    deliverable: Deliverable;
    failures: CheckResult[];
    retryCount: number;
  }): Promise<void>;
}

export interface VerificationEngineDeps {
  definitions: DefinitionStore;
  verdicts: VerdictStore;
  grader: IndependentGrader;
  approvals: VerificationApprovalSink;
  feedback: WorkerFeedback;
  caps: (workspaceId: string) => VerificationCaps;
  killSwitch: (workspaceId: string) => Promise<boolean>;
  redact: (text: string) => string;
  logger: SessionLogger;
  now?: () => Date;
}

export interface VerifyResult {
  decision: VerificationDecision;
  verdict: VerificationVerdict;
  record: VerificationVerdictRecord;
  /** The #13 request opened (on request_approval / escalate), else null. */
  approvalRequestId: string | null;
}

/** The terminal-disabled signal — verification did not run because the layer is off / killed. */
export type VerifySkip = { skipped: "disabled" | "kill_switch" };

export class VerificationEngine {
  constructor(private readonly deps: VerificationEngineDeps) {}

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Derive + persist the definition of done for a deliverable BEFORE it executes (#191 AC #1). Pure
   * derivation; the only side effect is the durable, visible criteria row. Returns the stored DoD.
   */
  async defineDone(input: {
    workspaceId: string;
    deliverableRef: string;
    deliverableKind: DeliverableKind;
    brief: string;
    reversibilityHint?: ReversibilityClass;
  }): Promise<DefinitionOfDoneRecord> {
    const dod = deriveDefinitionOfDone({
      deliverableKind: input.deliverableKind,
      brief: input.brief,
      reversibilityHint: input.reversibilityHint,
    });
    const problems = validateDefinitionOfDone(dod);
    if (problems.length > 0) {
      throw new Error(`invalid definition of done: ${problems.join("; ")}`);
    }
    return this.deps.definitions.record({
      workspaceId: input.workspaceId,
      deliverableRef: input.deliverableRef,
      deliverableKind: input.deliverableKind,
      reversibility: dod.reversibility,
      criteria: dod.criteria,
      briefDigest: this.deps.redact(input.brief).slice(0, 500),
      now: this.clock(),
    });
  }

  /**
   * Verify a deliverable against its definition of done (#191 AC #2-4). Runs the INDEPENDENT grader,
   * judges (pure), decides (pure), then applies the single decided side effect. A deliverable can only
   * reach `auto_proceed` through the pure decision — there is no other path past the gate, so nothing
   * ships unverified.
   *
   * If no DoD was pre-defined, one is derived on the fly from `fallbackBrief` (so the gate is never
   * skipped for lack of a spec); pre-defining via {@link defineDone} is the intended AC #1 path.
   */
  async verify(
    deliverable: Deliverable,
    opts: { fallbackBrief?: string } = {},
  ): Promise<VerifyResult | VerifySkip> {
    const caps = this.deps.caps(deliverable.workspaceId);
    if (!caps.enabled) return { skipped: "disabled" };
    if (await this.deps.killSwitch(deliverable.workspaceId)) {
      this.deps.logger.warn(
        { workspaceId: deliverable.workspaceId },
        "verification skipped: kill switch engaged",
      );
      return { skipped: "kill_switch" };
    }

    const dod = await this.resolveDefinition(deliverable, opts.fallbackBrief);

    // The SEPARATE grader judges the deliverable (AC #2). Its identity must differ from the worker's;
    // the pure grader records that as `independenceOk` and the pure decision refuses to proceed on it.
    const graded = await this.deps.grader.grade({ deliverable, dod });
    const verdict = gradeDeliverable(dod, graded.observations, {
      workerMemberId: deliverable.workerMemberId,
      graderMemberId: graded.graderMemberId,
    });

    const retryCount = await this.deps.verdicts.countReturns(
      deliverable.workspaceId,
      deliverable.deliverableRef,
    );
    const decision = decideVerification(verdict, dod, caps, retryCount);

    const approvalRequestId = await this.applyDecision(decision, deliverable, dod, verdict, retryCount);

    const record = await this.deps.verdicts.record({
      workspaceId: deliverable.workspaceId,
      deliverableRef: deliverable.deliverableRef,
      deliverableKind: deliverable.deliverableKind,
      status: decision.action,
      passed: verdict.passed,
      confidence: verdict.confidence,
      reversibility: dod.reversibility,
      independenceOk: verdict.independenceOk,
      productionGrounded: verdict.productionGrounded,
      retryCount,
      checks: verdict.checks.map((c) => ({ ...c, evidence: this.deps.redact(c.evidence) })),
      workerMemberId: deliverable.workerMemberId,
      graderMemberId: graded.graderMemberId,
      approvalRequestId,
      reason: this.deps.redact(decision.reason),
      now: this.clock(),
    });

    this.deps.logger.info(
      {
        workspaceId: deliverable.workspaceId,
        deliverableRef: deliverable.deliverableRef,
        action: decision.action,
        passed: verdict.passed,
        confidence: verdict.confidence,
        independenceOk: verdict.independenceOk,
      },
      "verification verdict recorded",
    );

    return { decision, verdict, record, approvalRequestId };
  }

  /** Resolve the stored DoD, or derive one on the fly so the gate is never skipped for lack of a spec. */
  private async resolveDefinition(
    deliverable: Deliverable,
    fallbackBrief?: string,
  ): Promise<DefinitionOfDone> {
    const stored = await this.deps.definitions.latest(
      deliverable.workspaceId,
      deliverable.deliverableRef,
    );
    if (stored) {
      return {
        deliverableKind: stored.deliverableKind,
        reversibility: stored.reversibility,
        criteria: stored.criteria,
      };
    }
    return deriveDefinitionOfDone({
      deliverableKind: deliverable.deliverableKind,
      brief: fallbackBrief ?? deliverable.content,
    });
  }

  /** Apply the single decided side effect; returns the #13 request id (when one is opened). */
  private async applyDecision(
    decision: VerificationDecision,
    deliverable: Deliverable,
    dod: DefinitionOfDone,
    verdict: VerificationVerdict,
    retryCount: number,
  ): Promise<string | null> {
    switch (decision.action) {
      case "request_approval": {
        const { id } = await this.deps.approvals.requestApproval({
          workspaceId: deliverable.workspaceId,
          deliverable,
          dod,
          verdict,
          reason: decision.reason,
        });
        return id;
      }
      case "escalate": {
        const { id } = await this.deps.approvals.escalate({
          workspaceId: deliverable.workspaceId,
          deliverable,
          dod,
          verdict,
          reason: decision.reason,
        });
        return id;
      }
      case "return_to_worker": {
        const failures = verdict.checks.filter((c) => c.required && !c.passed);
        await this.deps.feedback.returnToWorker({
          workspaceId: deliverable.workspaceId,
          deliverable,
          failures,
          retryCount,
        });
        return null;
      }
      case "auto_proceed":
        return null;
    }
  }
}
