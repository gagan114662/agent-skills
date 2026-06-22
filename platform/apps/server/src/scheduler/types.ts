/**
 * Durable, single-leader scheduler (#559). Replaces the per-engine `setInterval(() => this.tickAll(), ms)`
 * cadence (planning, venture-memory, verifiers, workflows) with ONE restart-safe scheduler whose state is a
 * row per job in `scheduler_jobs`. The persisted `next_run_at` cursor is the load-bearing field: a process
 * restart resumes from it (ticks paused by a crash fire as soon as they are overdue), and an atomic
 * compare-and-swap lease (`locked_by`/`locked_until`) makes "exactly one instance fires this interval"
 * a database invariant across N replicas — no double-fire (the premortem #200 §2 structural guarantee).
 *
 * Backoff reuses the durable-workflow bounded-backoff (`nextBackoffMs`): a failing tick is retried on a
 * `min(cap, base·factor^n)` cadence, so it can never hang and never stops the recurring loop forever.
 *
 * Nothing here imports the DB or a clock — the store and the `now()` seam are injected, so the decision
 * core is unit-pure (the same shape as durable-workflow + build-loop).
 */

export const SCHEDULER_RUN_STATUSES = ["ok", "error"] as const;
export type SchedulerRunStatus = (typeof SCHEDULER_RUN_STATUSES)[number];

/**
 * The persisted per-job state — the restart-safe cursor PLUS the observability row (last-run / next-run).
 * Times cross the seam as epoch ms so the pure core never touches `Date`.
 */
export interface SchedulerJobState {
  jobKey: string;
  /** The registered cadence (ms). Persisted so a running deployment can be inspected without the registry. */
  intervalMs: number;
  /** Epoch-ms the job is next eligible to run — the cursor that survives a restart. */
  nextRunAtMs: number;
  /** Epoch-ms of the last completed run, or null if it has never run. */
  lastRunAtMs: number | null;
  /** Outcome of the last completed run (observability), or null if it has never run. */
  lastStatus: SchedulerRunStatus | null;
  /** A short, redacted reason when `lastStatus === "error"`, else null. */
  lastError: string | null;
  /** Consecutive failures — drives the bounded backoff; reset to 0 on a successful run. */
  consecutiveFailures: number;
  /** The instance id currently holding the run lease, or null when unleased. */
  lockedBy: string | null;
  /** Epoch-ms the lease expires (a crashed leader's lock auto-frees so another instance reclaims), or null. */
  lockedUntilMs: number | null;
  updatedAtMs: number;
}

/** A registered recurring job: a key, a cadence, and the work to run (an engine's `tickAll`). */
export interface ScheduledJob {
  /** Stable identity of the job — the `scheduler_jobs.job_key` primary key (e.g. `planning`). */
  key: string;
  /** Cadence in ms. `<= 0` means disabled (the job is never enrolled — mirrors `start(0)` being a no-op). */
  intervalMs: number;
  /** The work to run each interval — an engine's `tickAll()`. MUST be idempotent across a reclaimed lease. */
  run: () => Promise<void>;
  /** Human label for logs (defaults to `key`). */
  label?: string;
}

/**
 * The minimal registry surface an engine depends on to enroll its tick. Keeping engines pinned to this
 * (rather than the concrete {@link DurableScheduler}) is what lets the unit tests drive scheduling with an
 * in-memory store and lets the engines stay free of any DB import.
 */
export interface SchedulerRegistry {
  register(job: ScheduledJob): void;
  deregister(key: string): void;
}

/**
 * The persistence seam the scheduler writes through. The production impl is the Postgres-backed
 * `dbSchedulerStore` (`db/repositories/scheduler-jobs.ts`); {@link InMemorySchedulerStore} backs unit tests
 * and the no-DB fallback. `claimDue` is the single-leader primitive — its atomicity is the whole guarantee.
 */
export interface SchedulerStore {
  /**
   * Idempotent registration: create the job row if absent (first cursor = `nowMs + intervalMs`, so a fresh
   * job fires after one interval, exactly like `setInterval`). An existing row keeps its persisted cursor
   * (restart-safe) but its `intervalMs` is refreshed to the registered value. Returns the current state.
   */
  ensureJob(input: { jobKey: string; intervalMs: number; nowMs: number }): Promise<SchedulerJobState>;
  /**
   * Atomically claim the job for THIS instance iff it is due (`next_run_at <= now`) AND unleased (or its
   * lease has expired). Returns the claimed state, or null when another instance owns this tick. The
   * atomicity of this single statement is what makes double-fire impossible across N instances.
   */
  claimDue(input: {
    jobKey: string;
    nowMs: number;
    leaseMs: number;
    instanceId: string;
  }): Promise<SchedulerJobState | null>;
  /** Release the lease and persist the new cursor + observability after a run (success or failure). */
  complete(input: {
    jobKey: string;
    instanceId: string;
    lastRunAtMs: number;
    nextRunAtMs: number;
    status: SchedulerRunStatus;
    error: string | null;
    consecutiveFailures: number;
  }): Promise<void>;
  /** Read a job's current state (observability: last-run / next-run / lease holder). */
  get(jobKey: string): Promise<SchedulerJobState | null>;
  /** All job states (the observability snapshot). */
  list(): Promise<SchedulerJobState[]>;
}
