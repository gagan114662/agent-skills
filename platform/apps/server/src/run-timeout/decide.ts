/**
 * Pure timeout decision for a run (issue #635). No IO, no `Date` — given a {@link RunTimeoutRecord} and
 * the current epoch-ms, decide whether the run is still within budget or which deadline it breached, and
 * build the user-facing diagnostics. The service (`service.ts`) does the IO around this.
 *
 * Priority (highest first):
 *   1. terminal      → `ok` (already finished; nothing to do)
 *   2. run wall-clock → `run_timeout`  (the whole run is over its budget — outranks any step)
 *   3. step budget    → `step_timeout` (the in-flight step is over its budget)
 *   4. otherwise      → `ok`
 *
 * The per-run deadline outranks the per-step one so a run that blows its overall budget is reported as a
 * run timeout even if a step deadline also happens to have passed — the more useful diagnosis.
 */

import { isTerminalRunStatus, type RunTimeoutRecord, type TimeoutDiagnostics } from "./types.js";

export type TimeoutDecision =
  | { kind: "ok" }
  | { kind: "run_timeout"; diagnostics: TimeoutDiagnostics }
  | { kind: "step_timeout"; diagnostics: TimeoutDiagnostics };

/** Format a non-negative ms duration as a compact human string: `90061000` ⇒ `"1d1h1m1s"`, `0` ⇒ `"0s"`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total === 0) return "0s";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);
  return parts.join("");
}

/** Idle gap (ms) since the run last reported progress, never negative. */
function idleMs(record: RunTimeoutRecord, nowMs: number): number {
  return Math.max(0, nowMs - record.lastHeartbeatAtMs);
}

/**
 * Decide whether `record` has timed out as of `nowMs`. Returns `ok` for any terminal run (idempotent —
 * a run already marked `timed_out` never re-fires) and for a run still within both budgets.
 */
export function decideTimeout(record: RunTimeoutRecord, nowMs: number): TimeoutDecision {
  if (isTerminalRunStatus(record.status)) return { kind: "ok" };

  const runElapsedMs = Math.max(0, nowMs - record.startedAtMs);

  // 2. Per-run wall-clock budget (outranks step).
  if (runElapsedMs >= record.runTimeoutMs) {
    const diagnostics: TimeoutDiagnostics = {
      kind: "run",
      message: `Run exceeded its ${formatDuration(record.runTimeoutMs)} budget (ran ${formatDuration(runElapsedMs)}).`,
      detectedAtMs: nowMs,
      runElapsedMs,
      runTimeoutMs: record.runTimeoutMs,
      idleMs: idleMs(record, nowMs),
      ...(record.stepName !== null && record.stepStartedAtMs !== null
        ? {
            step: {
              name: record.stepName,
              elapsedMs: Math.max(0, nowMs - record.stepStartedAtMs),
              timeoutMs: record.stepTimeoutMs,
            },
          }
        : {}),
    };
    return { kind: "run_timeout", diagnostics };
  }

  // 3. Per-step budget (only when a step is in flight).
  if (record.stepName !== null && record.stepStartedAtMs !== null) {
    const stepElapsedMs = Math.max(0, nowMs - record.stepStartedAtMs);
    if (stepElapsedMs >= record.stepTimeoutMs) {
      const diagnostics: TimeoutDiagnostics = {
        kind: "step",
        message: `Step "${record.stepName}" exceeded its ${formatDuration(record.stepTimeoutMs)} budget (ran ${formatDuration(stepElapsedMs)}).`,
        detectedAtMs: nowMs,
        runElapsedMs,
        runTimeoutMs: record.runTimeoutMs,
        idleMs: idleMs(record, nowMs),
        step: { name: record.stepName, elapsedMs: stepElapsedMs, timeoutMs: record.stepTimeoutMs },
      };
      return { kind: "step_timeout", diagnostics };
    }
  }

  // 4. Within budget.
  return { kind: "ok" };
}
