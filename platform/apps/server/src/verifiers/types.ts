/**
 * Shared types for Outcome Verifiers (#106, ADR-0106). The pure `registry`/`decide`/`guards`/`caps`
 * modules and the IO `engine` agree on these — mirroring the #112 SRE / #117 flywheel `types.ts` split
 * (pure decision in, side effects out).
 */

/**
 * The taxonomy of non-code claims a verifier measures. Bounded + stable: it is a low-cardinality metric
 * label and a `verifier_results.kind` CHECK value. Every claim the owner directive lists has a kind —
 * "deploy live? revenue event real? growth metric moved? fix held?".
 */
export const VERIFIER_KINDS = [
  "deploy_live",
  "revenue_real",
  "growth_metric",
  "fix_held",
] as const;
export type VerifierKind = (typeof VERIFIER_KINDS)[number];

export function isVerifierKind(value: unknown): value is VerifierKind {
  return typeof value === "string" && (VERIFIER_KINDS as readonly string[]).includes(value);
}

/**
 * One claim handed to the runner: WHAT to verify (`kind`), the thing it is about (`claimRef`, a soft
 * reference — a deployment id / venture id / fingerprint id), and the numeric `target` the measured
 * value is checked against. `source` is a free-form provenance tag carried onto the evidence row.
 */
export interface VerifierClaim {
  workspaceId: string;
  kind: VerifierKind;
  /** Soft ref to the subject (deployment / venture / fingerprint id). Never an FK — evidence is history. */
  claimRef: string;
  /** The threshold the measured value is compared against (kind-specific meaning). */
  target: number;
  /** Free-form provenance tag (e.g. `deploy`, `flywheel`, `billing`). */
  source?: string;
}

// ---- observations (the measured input per kind) ------------------------------------------------

/** `deploy_live`: an HTTP probe of the live URL. */
export interface DeployLiveObservation {
  /** The HTTP status of the live URL probe (0 ⇒ unreachable / transport error). */
  httpStatus: number;
  /** Whether the health endpoint reported healthy. */
  healthy: boolean;
}

/** `revenue_real`: the count of SETTLED #98 revenue events for the claim (not a #101 fake-door click). */
export interface RevenueRealObservation {
  realEventCount: number;
}

/** `growth_metric`: a metric's current value vs its baseline — the move is `current − baseline`. */
export interface GrowthMetricObservation {
  currentValue: number;
  baselineValue: number;
}

/** `fix_held`: recurrences of the fixed failure since the fix landed (the #117 signal). */
export interface FixHeldObservation {
  recurrenceCount: number;
}

export type Observation =
  | ({ kind: "deploy_live" } & DeployLiveObservation)
  | ({ kind: "revenue_real" } & RevenueRealObservation)
  | ({ kind: "growth_metric" } & GrowthMetricObservation)
  | ({ kind: "fix_held" } & FixHeldObservation);

/**
 * A sentinel an observation source returns when it could not MEASURE the claim (a transport error, an
 * unavailable source). The runner records `errored` and never escalates — escalating on an un-measurable
 * probe would cry wolf. Distinct from a measured failure.
 */
export interface ObservationError {
  kind: VerifierKind;
  errored: true;
  /** Why measurement failed (surfaced in the evidence detail + logs). */
  reason: string;
}

export function isObservationError(o: Observation | ObservationError): o is ObservationError {
  return (o as ObservationError).errored === true;
}

// ---- outcomes (pure) ---------------------------------------------------------------------------

/** The verdict of a pure verifier on a measured observation. */
export interface VerifierOutcome {
  passed: boolean;
  /** The single number behind the verdict (status code, event count, delta, recurrence count). */
  measuredValue: number;
  /** The threshold it was checked against (the claim's `target`, kind-normalized). */
  threshold: number;
  /** A short human summary (redacted before persist). */
  detail: string;
}

/** The terminal status persisted for a verification. */
export const VERIFIER_STATUSES = ["passed", "failed", "errored"] as const;
export type VerifierStatus = (typeof VERIFIER_STATUSES)[number];

/** One durable evidence row (one row in `verifier_results`). */
export interface VerifierResultRecord {
  id: string;
  workspaceId: string;
  kind: VerifierKind;
  claimRef: string;
  status: VerifierStatus;
  measuredValue: number;
  threshold: number;
  detail: string;
  /** The #13 request opened on failure (soft ref), or null on a pass / un-escalated. */
  escalationRequestId: string | null;
  source: string | null;
  createdAt: Date;
}

// ---- decisions (pure) --------------------------------------------------------------------------

/** What the runner does with a verification this tick. */
export type VerificationAction = "record_pass" | "escalate" | "skip";

export interface VerificationDecision {
  action: VerificationAction;
  /** The status to persist (an `escalate`/`skip` may still record `failed`/`errored`). */
  status: VerifierStatus;
  reason: string;
}
