/**
 * Durable-workflow primitive (#338, ADR-0338). The shared vocabulary for a long-running step that
 * **suspends, resumes, retries-with-backoff, and persists its state** instead of blocking the event loop
 * on a hand-rolled `while (Date.now() < deadline) { …; await sleep }` poll (the symptom the issue names:
 * the overnight loop that froze on a blocking `until` wait). It mirrors the proven build-loop (#172) +
 * watchdog (#105) split: a persisted run-ledger row + a *pure* decision core + a thin engine that does the
 * IO. Nothing here imports the DB or `fetch`; the store and the step handler are injected seams.
 *
 * Premortem #200 contract baked into the types:
 *  - §2/§3 production-grounded: a step's terminal result is read back from the persisted record, never
 *    assumed — a resumed run returns the *stored* result and never re-runs a finished step.
 *  - §4 reversibility: `requiresApproval` marks an irreversible step; the runner refuses to RUN it without
 *    an `approvalRequestId` (the structural #13 always-gate), parking the run `waiting_approval`.
 */

/** The durable run lifecycle. `succeeded`/`failed`/`canceled` are terminal (idempotent — never re-run). */
export const DURABLE_RUN_STATUSES = [
  "running",
  "suspended",
  "waiting_approval",
  "succeeded",
  "failed",
  "canceled",
] as const;

export type DurableRunStatus = (typeof DURABLE_RUN_STATUSES)[number];

/** The terminal set — a run in any of these is done forever; advancing it is a no-op (idempotency §2). */
export const TERMINAL_STATUSES: ReadonlySet<DurableRunStatus> = new Set<DurableRunStatus>([
  "succeeded",
  "failed",
  "canceled",
]);

export function isTerminal(status: DurableRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Bounded retry-with-backoff policy. `maxAttempts` is the hard cap that turns "retry forever" into an
 * eventual `failed` (the no-hang guarantee at the attempt axis); `baseMs * factor^attempt`, capped at
 * `capMs`, is the wait between attempts. Deterministic — no clock/jitter in the core (so it is unit-pure).
 */
export interface BackoffPolicy {
  baseMs: number;
  factor: number;
  capMs: number;
  maxAttempts: number;
}

/**
 * A durable run as persisted (the DB row shape, times as epoch ms so the pure core never touches `Date`).
 * `idempotencyKey` is the dedup anchor — `unique(workspace_id, idempotency_key)` makes "one run per logical
 * job" a database invariant, exactly like build-loop's `unique(workspace_id, issue_ref)`.
 */
export interface DurableRunRecord<TState = unknown, TResult = unknown> {
  id: string;
  workspaceId: string;
  /** The workflow kind (e.g. `github_pages_build_wait`) — groups runs for observability. */
  workflowKey: string;
  /** The dedup key within the workspace (e.g. `github_pages:owner/repo`). */
  idempotencyKey: string;
  status: DurableRunStatus;
  /** Attempts of the current step already RUN (the backoff/exhaustion counter). */
  attempts: number;
  /** Epoch-ms the next attempt is eligible (set when suspended for backoff); null when runnable now. */
  nextAttemptAtMs: number | null;
  /** Epoch-ms hard deadline — once `now >= deadlineAtMs` the run fails `timeout` (the no-hang guarantee). */
  deadlineAtMs: number;
  /** Whether the step is irreversible (#200 §4) → cannot RUN without an `approvalRequestId` (#13 gate). */
  requiresApproval: boolean;
  /** The #13 approval that authorized an irreversible step, or null (the structural gate's load-bearing field). */
  approvalRequestId: string | null;
  /** Caller state carried across suspensions (jsonb) — opaque to the engine. */
  state: TState;
  /** The terminal result, persisted on success so a resumed run reads it back rather than re-running (§2). */
  result: TResult | null;
  /** A short, redacted failure reason when `status === "failed"`, or null. */
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * The outcome of running ONE step. `done` carries the terminal result; `pending` means "not ready, retry
 * with backoff"; `failed` distinguishes a retryable transient from a hard stop. A step handler MUST be
 * idempotent: a resumed run may call it again for the same attempt (premortem #200 §3 — never assume the
 * previous attempt's side effect did or didn't land; re-running must not double-apply).
 */
export type StepOutcome<TResult = unknown> =
  | { type: "done"; result: TResult }
  | { type: "pending" }
  | { type: "failed"; retryable: boolean; error?: string };

/** A single-step durable job: poll/attempt the work, returning a {@link StepOutcome}. */
export interface StepHandler<TState = unknown, TResult = unknown> {
  step(state: TState): Promise<StepOutcome<TResult>>;
}

/** The action the pure {@link decideStep} hands the runner this tick (mirrors `decideRevival`). */
export type DurableAction =
  | { kind: "run"; reason: string }
  | { kind: "wait"; untilMs: number; reason: string }
  | { kind: "gate"; reason: string }
  | { kind: "timeout"; reason: string }
  | { kind: "exhausted"; reason: string }
  | { kind: "done"; reason: string };
