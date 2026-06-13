/**
 * Shared types for the Deliverable Verification Layer (#191, ADR-0191) — "nothing ships unverified".
 *
 * This is the contract that makes "define done before doing → an INDEPENDENT verifier grades the work
 * → fail/fix loop → proof on the approval card" a property of the code. The pure modules
 * (`criteria` / `grade` / `decide` / `caps`) and the IO `engine` all agree on these types: a pure
 * decision goes in, side effects come out — mirroring the #106 outcome-verifier and #112/#117 splits.
 *
 * Distinct from #106 `verifiers/`, which measures venture *outcomes* (deploy live? revenue real?). This
 * layer gates a *deliverable* (a piece of outbound content, a support reply, a campaign change, a
 * venture deploy) BEFORE it can request approval or auto-send.
 */

/**
 * The deliverables this layer gates (#191 AC #5). Bounded + stable — it is a low-cardinality metric
 * label and a `verification_*.deliverable_kind` CHECK value. Code already has CI; these are the claims
 * without a test suite.
 */
export const DELIVERABLE_KINDS = [
  "outbound_content",
  "support_reply",
  "campaign_change",
  "venture_deploy",
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return typeof value === "string" && (DELIVERABLE_KINDS as readonly string[]).includes(value);
}

/**
 * Reversibility classes (premortem #200 §4). "Without mistakes" = bounded blast radius + fast detection
 * + cheap reversal. An `irreversible` action (deliverability, brand, legal, money) can NEVER auto-proceed
 * — it is pre-committed or human-gated, never post-hoc reviewed.
 */
export const REVERSIBILITY_CLASSES = ["reversible", "cheap", "irreversible"] as const;
export type ReversibilityClass = (typeof REVERSIBILITY_CLASSES)[number];

export function isReversibilityClass(value: unknown): value is ReversibilityClass {
  return typeof value === "string" && (REVERSIBILITY_CLASSES as readonly string[]).includes(value);
}

/**
 * The category of a success criterion — it decides how the criterion is graded.
 *   - `content`:    a qualitative judgement ("the reply answers the question") — the grader's verdict.
 *   - `metric`:     a numeric claim that ONLY counts when backed by an external receipt (premortem #2).
 *   - `production`: a production-grounded check (real spawn / click-through / canary) — premortem #3's
 *                   only-final-tier. A production criterion passes only on production-grounded evidence.
 */
export const CRITERION_CATEGORIES = ["content", "metric", "production"] as const;
export type CriterionCategory = (typeof CRITERION_CATEGORIES)[number];

/** One checkable success criterion — part of the "definition of done" derived before doing (#191 AC #1). */
export interface SuccessCriterion {
  /** Stable slug, unique within a definition of done (the join key to a {@link CheckObservation}). */
  id: string;
  /** Human description, shown on the approval card (receipts over a bare "ready"). */
  text: string;
  category: CriterionCategory;
  /** A `required` criterion must pass for the deliverable to pass; a non-required one is advisory. */
  required: boolean;
}

/** The "definition of done" for one deliverable — derived from its brief, stored, visible (#191 AC #1). */
export interface DefinitionOfDone {
  deliverableKind: DeliverableKind;
  /** The blast-radius class that decides whether a verified deliverable may ever auto-proceed. */
  reversibility: ReversibilityClass;
  criteria: SuccessCriterion[];
}

/**
 * Metric provenance (premortem #200 §2). A metric is only VERIFIED when it is backed by an external
 * receipt (a Stripe event, a delivery webhook, an analytics record). An `estimate` is UNVERIFIED and can
 * never, on its own, clear a gate or drive kill/scale.
 */
export const METRIC_PROVENANCE = ["external_receipt", "estimate"] as const;
export type MetricProvenance = (typeof METRIC_PROVENANCE)[number];

/** A numeric claim attached to a metric-category check. Verified only with `external_receipt` + a ref. */
export interface MetricClaim {
  name: string;
  value: number;
  provenance: MetricProvenance;
  /** The external receipt id (Stripe event / webhook / analytics ref). Required for a VERIFIED metric. */
  receiptRef?: string;
}

/** True only when the metric is backed by an external receipt — the premortem #2 "no fiction" rule. */
export function isVerifiedMetric(m: MetricClaim): boolean {
  return m.provenance === "external_receipt" && typeof m.receiptRef === "string" && m.receiptRef.length > 0;
}

/**
 * One raw observation the independent grader produces for a criterion. The grader judges
 * `satisfied` + `confidence` + `evidence`; for metric criteria it attaches the backing {@link MetricClaim};
 * `productionGrounded` is true when the observation touched reality (a real spawn / click / canary).
 */
export interface CheckObservation {
  criterionId: string;
  satisfied: boolean;
  /** The grader's confidence in this judgement, 0..1. */
  confidence: number;
  /** Short evidence string (redacted before persist). */
  evidence: string;
  /** For a metric criterion — the numeric claim + its provenance. */
  metric?: MetricClaim;
  /** Whether this observation was production-grounded (premortem #3's final tier). */
  productionGrounded: boolean;
}

/** The graded result for one criterion — the per-check pass/fail + confidence shown on the card (#191 AC #4). */
export interface CheckResult {
  criterionId: string;
  category: CriterionCategory;
  required: boolean;
  passed: boolean;
  confidence: number;
  evidence: string;
  /** Set for a metric criterion: whether it was backed by an external receipt (premortem #2). */
  metricVerified: boolean;
  productionGrounded: boolean;
}

/** Who produced the deliverable vs who graded it — the independence proof (#191 AC #2). */
export interface VerificationIdentity {
  /** The member id of the worker that produced the deliverable. */
  workerMemberId: string;
  /** The member id of the SEPARATE verifier that graded it. Must differ from the worker. */
  graderMemberId: string;
}

/** The full verdict of one independent verification pass — persisted + attached to the approval card. */
export interface VerificationVerdict {
  /** True when every REQUIRED check passed. */
  passed: boolean;
  /** Aggregate confidence over required checks (the min — the weakest link), 0 when none/any missing. */
  confidence: number;
  checks: CheckResult[];
  workerMemberId: string;
  graderMemberId: string;
  /** The structural "the worker never grades its own homework" invariant (#191 AC #2). */
  independenceOk: boolean;
  /** True when every required production-category check was production-grounded (premortem #3). */
  productionGrounded: boolean;
}

// ---- decisions (pure) --------------------------------------------------------------------------

/**
 * What the layer does with a verified deliverable:
 *   - `auto_proceed`:     verified + reversible + the deployment opted into auto-send (never irreversible).
 *   - `request_approval`: attach the proof to a #13 approval card for a human (the default for a pass).
 *   - `return_to_worker`: a failed/low-confidence verification goes back to the worker with the failures.
 *   - `escalate`:         non-independent grade, or repeated failure → the decision queue.
 */
export const VERIFICATION_ACTIONS = [
  "auto_proceed",
  "request_approval",
  "return_to_worker",
  "escalate",
] as const;
export type VerificationAction = (typeof VERIFICATION_ACTIONS)[number];

export interface VerificationDecision {
  action: VerificationAction;
  reason: string;
}

/** One durable verdict row (one row in `verification_verdicts`). */
export interface VerificationVerdictRecord {
  id: string;
  workspaceId: string;
  deliverableRef: string;
  deliverableKind: DeliverableKind;
  status: VerificationAction;
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
  createdAt: Date;
}

/** One durable definition-of-done row (one row in `verification_criteria`). */
export interface DefinitionOfDoneRecord {
  id: string;
  workspaceId: string;
  deliverableRef: string;
  deliverableKind: DeliverableKind;
  reversibility: ReversibilityClass;
  criteria: SuccessCriterion[];
  briefDigest: string;
  createdAt: Date;
}
