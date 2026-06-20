import { classifyFailure, isSuccess, type FailureReasonClass } from "./outcome.js";
import type { SessionStatus } from "./types.js";

/**
 * #394 — Make the "~40% of agent sessions fail/hang" rate MEASURABLE by class.
 *
 * Before this, the only failure signal was {@link classifyFailure} re-derived per row at read time
 * inside the #230 diagnostic, which surfaces a single dominant class but never the full breakdown or
 * the rate. You cannot harden what you cannot count: to drive the failure rate under 10% we first need
 * to know which class (spawn / timeout / model / …) dominates the reaps. This pure summarizer turns a
 * window of terminal sessions into a per-class histogram + failure rate, reusing the SAME classifier
 * the terminal message and diagnostic use so the numbers can never drift from what the owner sees.
 *
 * Pure: no IO, no clock. The caller passes the session window; every branch is unit-tested.
 */

/** The minimal terminal-session shape needed to classify a failure (matches the diagnostic's input). */
export interface FailureStatsInput {
  status: SessionStatus;
  exitCode: number | null;
  /** Already-redacted terminal tail — used ONLY to refine the class, never rendered. */
  result: string | null;
}

export interface FailureStats {
  /** Terminal sessions considered (provisioning/running are excluded by the caller). */
  total: number;
  /** Sessions that ended cleanly (`completed`). */
  succeeded: number;
  /** Terminal sessions that did NOT succeed. */
  failed: number;
  /** failed / total, 0 when there are no terminal sessions. Rounded to 4 dp. */
  failureRate: number;
  /** Count per failure class (only classes that occurred appear). */
  byClass: Partial<Record<FailureReasonClass, number>>;
  /** The most frequent failure class (ties → first-seen), or null when nothing failed. */
  dominantClass: FailureReasonClass | null;
}

/**
 * Summarize a window of TERMINAL sessions into a failure histogram + rate. The caller is responsible
 * for passing only terminal rows (completed/failed/timeout/idle_reaped/canceled) — a still-running
 * session has no honest outcome to count yet.
 */
export function summarizeFailureClasses(sessions: readonly FailureStatsInput[]): FailureStats {
  const byClass: Partial<Record<FailureReasonClass, number>> = {};
  const order: FailureReasonClass[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const s of sessions) {
    if (isSuccess(s.status)) {
      succeeded += 1;
      continue;
    }
    failed += 1;
    const cls = classifyFailure({ status: s.status, exitCode: s.exitCode, outputTail: s.result ?? undefined });
    if (byClass[cls] === undefined) order.push(cls);
    byClass[cls] = (byClass[cls] ?? 0) + 1;
  }

  const total = sessions.length;
  const failureRate = total === 0 ? 0 : Math.round((failed / total) * 10_000) / 10_000;

  // Dominant = highest count, ties broken by first-seen so the result is deterministic.
  let dominantClass: FailureReasonClass | null = null;
  let bestN = 0;
  for (const cls of order) {
    const n = byClass[cls]!;
    if (n > bestN) {
      bestN = n;
      dominantClass = cls;
    }
  }

  return { total, succeeded, failed, failureRate, byClass, dominantClass };
}
