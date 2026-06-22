/**
 * Run-timeout / lifecycle types (issue #635).
 *
 * A *run* is one agent execution. Today a run that hangs — a wedged tool call, a stalled model
 * stream, a step that never returns — stays in `running` forever: the UI spins, and the resources it
 * holds (its git worktree, its scheduler lease/lock) are never freed. This module gives every run two
 * deadlines — a per-step budget and a per-run wall-clock budget — and a sweep that transitions any run
 * past a deadline to a clear terminal `timed_out` state, attaches diagnostics explaining *why*, and
 * frees its resources.
 *
 * Everything here is plain data + a pure decision (see `decide.ts`); all IO lives behind the
 * {@link RunTimeoutStore} and resource-releaser seams (the #17 pure-core + injected-seam pattern), so
 * the whole feature is unit-tested with no clock and no database.
 *
 * Self-contained on purpose (the #670/#674 convention): this module owns its own table via an
 * idempotent `CREATE TABLE IF NOT EXISTS` (see `default.ts`) and reads config from the environment
 * (see `caps.ts`), so the #635 change set touches no migration, no schema barrel, and no app-wiring
 * registry — it never collides with a sibling branch.
 */

/** Lifecycle status of a run. `running` is the only non-terminal state. */
export type RunLifecycleStatus = "running" | "completed" | "failed" | "timed_out";

/** The terminal states a run can end in. */
export const TERMINAL_RUN_STATUSES: readonly RunLifecycleStatus[] = ["completed", "failed", "timed_out"];

/** True if `status` is a terminal (no longer running) state. */
export function isTerminalRunStatus(status: RunLifecycleStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Which deadline a run breached. `run` = the overall wall-clock budget; `step` = a single step's budget. */
export type TimeoutKind = "run" | "step";

/**
 * Human-readable, machine-inspectable explanation of why a run timed out — surfaced to the user (so a
 * hung run is never a bare spinner) and logged for diagnosis.
 */
export interface TimeoutDiagnostics {
  /** Which deadline was breached. */
  kind: TimeoutKind;
  /** Stable, user-facing sentence, e.g. `"Run exceeded its 30m budget (ran 31m2s)."` */
  message: string;
  /** Epoch-ms the timeout was detected (i.e. the sweep tick that caught it). */
  detectedAtMs: number;
  /** Total run wall-clock at detection. */
  runElapsedMs: number;
  /** The configured per-run budget. */
  runTimeoutMs: number;
  /** Step detail, present when a step was in flight (always present for a `step` timeout). */
  step?: {
    name: string;
    elapsedMs: number;
    timeoutMs: number;
  };
  /** How long since the run last reported progress (a heartbeat), if it ever did. */
  idleMs?: number;
}

/**
 * One run tracked for timeout. Times are epoch-ms (the pure core never touches `Date`); `null` fields
 * are "not yet known" (no step in flight, not yet ended). `workspaceId` scopes every read — a caller
 * can only ever see its own tenant's runs (the #3 IDOR boundary).
 */
export interface RunTimeoutRecord {
  /** Server-issued run id (the primary key). */
  runId: string;
  /** Owning workspace (IDOR scoping). */
  workspaceId: string;
  /** The agent session whose worktree should be released on timeout, if any. */
  sessionId: string | null;
  /** A lock / scheduler-lease key to release on timeout, if any. */
  lockKey: string | null;
  status: RunLifecycleStatus;
  /** When the run started. */
  startedAtMs: number;
  /** `startedAtMs + runTimeoutMs` — the hard per-run wall-clock deadline. */
  deadlineAtMs: number;
  /** Per-run budget. */
  runTimeoutMs: number;
  /** Per-step budget — the longest any single step may run. */
  stepTimeoutMs: number;
  /** The step currently in flight, or `null` between steps. */
  stepName: string | null;
  /** When the current step started, or `null`. */
  stepStartedAtMs: number | null;
  /** Last time the run reported progress (defaults to `startedAtMs`). */
  lastHeartbeatAtMs: number;
  /** When the run reached a terminal state, or `null` while running. */
  endedAtMs: number | null;
  /** Which deadline it breached, if it timed out. */
  timeoutKind: TimeoutKind | null;
  /** Diagnostics, present once it has timed out. */
  diagnostics: TimeoutDiagnostics | null;
}

/** Input to start tracking a run. Per-run/per-step budgets fall back to the configured caps when omitted. */
export interface StartRunInput {
  runId: string;
  workspaceId: string;
  sessionId?: string | null;
  lockKey?: string | null;
  /** Override the per-run budget (ms). Defaults to {@link RunTimeoutCaps.runTimeoutMs}. */
  runTimeoutMs?: number;
  /** Override the per-step budget (ms). Defaults to {@link RunTimeoutCaps.stepTimeoutMs}. */
  stepTimeoutMs?: number;
}

/** A patch the store applies to a run record. Every field is optional (sparse update). */
export interface RunTimeoutPatch {
  status?: RunLifecycleStatus;
  stepName?: string | null;
  stepStartedAtMs?: number | null;
  lastHeartbeatAtMs?: number;
  endedAtMs?: number | null;
  timeoutKind?: TimeoutKind | null;
  diagnostics?: TimeoutDiagnostics | null;
}

// Re-exported here so config types live in one import for callers.
export type { RunTimeoutCaps } from "./caps.js";
