/**
 * Shared types for the Self-Healing Flywheel (#117, ADR-0117). The pure `fingerprint`/`caps`/`guards`/
 * `decide`/`rank`/`render` modules and the IO `engine` agree on these — mirroring the #105 watchdog and
 * #96 venture `types.ts` split (pure decision in, side effects out).
 */

/**
 * The taxonomy of failures the flywheel fingerprints. Bounded + stable: it is part of the signature
 * hash (so an identical message from two sources stays two fingerprints) and a low-cardinality metric
 * value. Every source the owner directive lists has a class, even ones not yet hot-wired (the seam is
 * the contract — see the spec's non-goals).
 */
export const FAILURE_CLASSES = [
  "harness_crash",
  "ci_fail",
  "watchdog_revival",
  "slo_breach",
  "venture_error",
  // #146: a repeated constitution violation fingerprints + dedupes into an issue like any other failure.
  "constitution_violation",
  "eval_regression", // #155: an offline agent-skill eval suite dropped below its baseline pass-rate
  "workflow_fail", // #152: a workflow firing's action failed — fingerprints + dedupes like any failure
  "qa_failure", // #171: the self-QA synthetic user found a product-surface bug on the live deployment
  "customer_complaint", // #190: a recurring support complaint crossed the threshold → one deduped backlog issue
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === "string" && (FAILURE_CLASSES as readonly string[]).includes(value);
}

/**
 * One raw failure handed to `record()`. The source owns the `secrets` map (the session's resolved
 * secret values) so the redactor can scrub them from the sample bundle BEFORE it is persisted — the
 * map itself is never stored or logged (#25). All fields but `workspaceId`/`failureClass`/`message`
 * are optional so a thin call-site stays a one-liner.
 */
export interface FailureEvent {
  workspaceId: string;
  failureClass: FailureClass;
  /** The raw failure message/headline — normalized + hashed into the signature. */
  message: string;
  /** A free-form source tag (e.g. `watchdog`, `harness`, `ci`) for the evidence bundle. */
  source?: string;
  /** Extra context (stack excerpt, command, etc.) — redacted into the sample bundle. */
  detail?: string;
  /** Distributed-trace id for the evidence bundle (helps a human find the original). */
  traceId?: string;
  /** The originating session, if any (soft reference — audit only). */
  sessionId?: string;
  /**
   * Where a fix agent should be launched if this fingerprint is auto-dispatched — the originating
   * channel + agent member (e.g. the #105 watchdog passes the stalled session's channel/agent). Absent
   * for context-less sources (CI/SLO); those queue for a human, who supplies the target on approval.
   */
  channelId?: string;
  agentMemberId?: string;
  /** The session's resolved secret values to scrub from the bundle (#25). Never persisted. */
  secrets?: Record<string, string>;
}

/** The lifecycle of a fingerprint. `fixed` is terminal until a recurrence flips it to `recurred`. */
export const FINGERPRINT_STATUSES = ["open", "issued", "fixing", "fixed", "recurred"] as const;
export type FingerprintStatus = (typeof FINGERPRINT_STATUSES)[number];

/** A deduped failure fingerprint (one row in `failure_fingerprints`). */
export interface FingerprintRecord {
  id: string;
  workspaceId: string;
  /** The stable dedup key (`class + normalized message`, hashed). */
  signature: string;
  failureClass: FailureClass;
  title: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
  /** The REDACTED sample context bundle (JSON string) — render sites read only this. */
  sampleContext: string;
  status: FingerprintStatus;
  /** The single open issue's canonical ref, or null before one is filed (the dedup anchor). */
  issueRef: string | null;
  /** `open` | `closed` — the last-synced GitHub state. */
  issueState: string | null;
  /** The occurrence count at the last issue draft/comment (so we only comment on NEW occurrences). */
  syncedOccurrenceCount: number;
  /** Where a fix agent is launched (carried from the originating failure), or null. */
  originChannelId: string | null;
  originAgentMemberId: string | null;
  /** The dispatched fix session (soft reference), or null. */
  fixSessionId: string | null;
  /** The merged fix's ref (e.g. a PR/commit), set by `markFixed`. */
  fixRef: string | null;
  fixedAt: Date | null;
  /** Recurrence-after-fix removes a class from auto-dispatch (human review required) — #106. */
  excludedFromAutoDispatch: boolean;
  /** Escalated priority (a recurrence, or a non-retryable class). */
  escalated: boolean;
}

/** How a fix was dispatched. `auto` launched a session; `queued` enqueued a #13 approval. */
export const FIX_DISPATCH_MODES = ["auto", "queued"] as const;
export type FixDispatchMode = (typeof FIX_DISPATCH_MODES)[number];

export const FIX_DISPATCH_STATUSES = ["dispatched", "queued", "done", "failed"] as const;
export type FixDispatchStatus = (typeof FIX_DISPATCH_STATUSES)[number];

/** One fix dispatch attempt (one row in `flywheel_fix_dispatches`) — the concurrency ledger + queue. */
export interface FixDispatchRecord {
  id: string;
  workspaceId: string;
  fingerprintId: string;
  mode: FixDispatchMode;
  status: FixDispatchStatus;
  sessionId: string | null;
  approvalRequestId: string | null;
  reason: string;
  createdAt: Date;
}

// ---- decisions (pure) --------------------------------------------------------------------------

/** The single issue-synthesis action the engine applies to a fingerprint this tick. */
export type IssueAction = "draft" | "comment" | "reopen" | "noop";

export interface IssueDecision {
  action: IssueAction;
  reason: string;
}

/** The single fix-dispatch action for a fingerprint this tick. */
export type DispatchAction = "auto" | "queue" | "skip";

export interface DispatchDecision {
  action: DispatchAction;
  reason: string;
}
