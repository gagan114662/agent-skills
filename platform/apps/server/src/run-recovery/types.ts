/**
 * Crash/restart run-recovery types (issue #643).
 *
 * A *run* is one agent execution. When the server process crashes or is restarted mid-run, every run
 * it was driving is silently orphaned: it stays `running` in the database forever, its UI spins, and the
 * git worktree + scheduler lock it held are never reconciled — leaving the system in an inconsistent
 * state with no path back. This module gives every run an **owner instance** stamp and a one-shot
 * **recovery pass** that, on the next boot, reconciles every orphaned run: a *resumable* run is re-owned
 * (and its worktree/lock reconciled) so the integrator can re-drive it, and a *non-resumable* one is
 * transitioned to a clear terminal `failed` state with a reason, freeing the resources it held.
 *
 * Everything here is plain data + a pure decision (see `decide.ts`); all IO lives behind the
 * {@link RunRecoveryStore} and {@link RunReconciler} seams (the #17 pure-core + injected-seam pattern),
 * so the whole feature is unit-tested with no clock, no boot, and no database.
 *
 * Self-contained on purpose (the #635/#670/#674 convention): this module owns its own table via an
 * idempotent `CREATE TABLE IF NOT EXISTS` (see `default.ts`) and reads config from the environment
 * (see `caps.ts`), so the #643 change set touches no migration, no schema barrel, and no app-wiring
 * registry — it never collides with a sibling branch.
 */

/** Lifecycle status of a run. `running` is the only non-terminal state. */
export type RunStatus = "running" | "completed" | "failed";

/** The terminal states a run can end in. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed"];

/** True if `status` is a terminal (no longer running) state. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Why the recovery pass failed an orphaned run instead of resuming it.
 *   - `not_resumable`           — the run was never flagged resumable (e.g. no checkpoint to resume from).
 *   - `max_attempts_exhausted`  — it has already been resumed across restarts up to the configured budget;
 *                                 resuming again risks a crash loop (a run that crashes the app each boot).
 */
export type FailureReason = "not_resumable" | "max_attempts_exhausted";

/** What the recovery pass decided to do with an orphaned run. */
export type RecoveryAction = "resume" | "fail";

/**
 * Human-readable, machine-inspectable explanation of how an orphaned run was recovered — surfaced to the
 * user (so a run interrupted by a crash is never a bare spinner) and logged for diagnosis.
 */
export interface RecoveryDiagnostics {
  /** Whether the run was resumed or failed. */
  action: RecoveryAction;
  /** For a failure, why; for a resume, the sentinel `"resumable"`. */
  reason: FailureReason | "resumable";
  /** Stable, user-facing sentence, e.g. `"Run was interrupted by a restart and resumed (attempt 2)."` */
  message: string;
  /** Epoch-ms the recovery was performed (the boot/sweep that caught it). */
  detectedAtMs: number;
  /** The (now-dead) instance that was driving the run when it was orphaned. */
  orphanedFromInstanceId: string;
  /** The resume-attempt number this recovery represents (1 on the first restart, incremented each boot). */
  resumeAttempt: number;
}

/**
 * One run tracked for crash recovery. Times are epoch-ms (the pure core never touches `Date`); `null`
 * fields are "not yet known" (not yet ended, never recovered). `workspaceId` scopes every tenant read — a
 * caller can only ever see its own tenant's runs (the #3 IDOR boundary).
 */
export interface RunRecord {
  /** Server-issued run id (the primary key). */
  runId: string;
  /** Owning workspace (IDOR scoping). */
  workspaceId: string;
  /** The agent session whose worktree to reconcile/release on recovery, if any. */
  sessionId: string | null;
  /** A lock / scheduler-lease key to reconcile/release on recovery, if any. */
  lockKey: string | null;
  /**
   * The process instance currently driving this run. A run is *orphaned* when it is still `running` but
   * its owner is not the live instance — i.e. the process that stamped it has died (a crash/restart).
   */
  ownerInstanceId: string;
  status: RunStatus;
  /**
   * Whether the run can be resumed after an interruption (has it reached a checkpoint it can continue
   * from?). Set at start and flipped as the run progresses; a non-resumable orphan is failed, not resumed.
   */
  resumable: boolean;
  /** When the run started. */
  startedAtMs: number;
  /** Last time the run reported progress (defaults to `startedAtMs`). */
  lastHeartbeatAtMs: number;
  /** How many times this run has been resumed across restarts (0 until first recovery). */
  resumeAttempts: number;
  /** When the run was last recovered (resumed) by a boot pass, or `null`. */
  lastRecoveredAtMs: number | null;
  /** When the run reached a terminal state, or `null` while running. */
  endedAtMs: number | null;
  /** Why it failed, if a recovery pass (or graceful completion) failed it. */
  failureReason: FailureReason | null;
  /** Diagnostics from the most recent recovery action, present once recovered or recovery-failed. */
  recovery: RecoveryDiagnostics | null;
}

/** Input to start tracking a run. `resumable` defaults to false (a run must opt in to being resumed). */
export interface StartRunInput {
  runId: string;
  workspaceId: string;
  sessionId?: string | null;
  lockKey?: string | null;
  /** Whether the run is resumable from the outset. Defaults to `false`. */
  resumable?: boolean;
}

/** A patch the store applies to a run record. Every field is optional (sparse update). */
export interface RunRecordPatch {
  ownerInstanceId?: string;
  status?: RunStatus;
  resumable?: boolean;
  lastHeartbeatAtMs?: number;
  resumeAttempts?: number;
  lastRecoveredAtMs?: number | null;
  endedAtMs?: number | null;
  failureReason?: FailureReason | null;
  recovery?: RecoveryDiagnostics | null;
}

// Re-exported here so config types live in one import for callers.
export type { RunRecoveryCaps } from "./caps.js";
