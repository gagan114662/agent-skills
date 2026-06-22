/**
 * Pure recovery decision for a run (issue #643). No IO, no `Date` — given a {@link RunRecord}, the live
 * instance id, the current epoch-ms, and the resume-attempt budget, decide what the boot recovery pass
 * should do with the run. The service (`service.ts`) does the IO (persist + reconcile) around this.
 *
 * Priority (highest first):
 *   1. terminal              → `skip` (already finished; nothing to recover)
 *   2. owned by live instance → `skip` (the current process is legitimately driving it — not orphaned)
 *   3. orphaned + resumable + within attempt budget → `resume`
 *   4. orphaned + not resumable                     → `fail` (`not_resumable`)
 *   5. orphaned + resume budget exhausted           → `fail` (`max_attempts_exhausted`)
 *
 * Resuming re-owns the run under the live instance and increments its attempt count; the attempt budget
 * (rule 5) stops a run that crashes the app on every boot from resuming forever — after the budget it is
 * failed with a clear reason instead.
 */

import {
  isTerminalRunStatus,
  type FailureReason,
  type RecoveryDiagnostics,
  type RunRecord,
} from "./types.js";

/** Context the pure decision needs: the live instance, the clock tick, and the resume budget. */
export interface RecoveryContext {
  /** The id of the process performing recovery (the live instance). */
  instanceId: string;
  /** Current epoch-ms (the boot/sweep tick). */
  nowMs: number;
  /** Max times a run may be resumed across restarts before it is failed instead. */
  maxResumeAttempts: number;
}

export type RecoveryDecision =
  | { kind: "skip"; reason: "terminal" | "owned" }
  | { kind: "resume"; diagnostics: RecoveryDiagnostics }
  | { kind: "fail"; reason: FailureReason; diagnostics: RecoveryDiagnostics };

/**
 * Decide how to recover `record` as of `ctx`. Returns `skip` for any terminal run and for a run the live
 * instance already owns (so re-running recovery is idempotent and never disturbs healthy in-flight runs).
 */
export function decideRecovery(record: RunRecord, ctx: RecoveryContext): RecoveryDecision {
  if (isTerminalRunStatus(record.status)) return { kind: "skip", reason: "terminal" };
  // The live process is driving this run — it isn't orphaned. (On a fresh boot no run is yet owned by the
  // new instance, so every still-`running` run from the dead instance is correctly caught below.)
  if (record.ownerInstanceId === ctx.instanceId) return { kind: "skip", reason: "owned" };

  const resumeAttempt = record.resumeAttempts + 1;
  const base = {
    detectedAtMs: ctx.nowMs,
    orphanedFromInstanceId: record.ownerInstanceId,
  };

  // 4. Orphaned but never resumable → fail with a clear reason.
  if (!record.resumable) {
    const diagnostics: RecoveryDiagnostics = {
      ...base,
      action: "fail",
      reason: "not_resumable",
      resumeAttempt: record.resumeAttempts,
      message: "Run was interrupted by a restart and could not be resumed (no resumable checkpoint).",
    };
    return { kind: "fail", reason: "not_resumable", diagnostics };
  }

  // 5. Orphaned, resumable, but out of resume attempts → fail to break a crash loop.
  if (record.resumeAttempts >= ctx.maxResumeAttempts) {
    const diagnostics: RecoveryDiagnostics = {
      ...base,
      action: "fail",
      reason: "max_attempts_exhausted",
      resumeAttempt: record.resumeAttempts,
      message: `Run was interrupted by a restart but had already been resumed ${record.resumeAttempts} time(s) (resume budget ${ctx.maxResumeAttempts} exhausted).`,
    };
    return { kind: "fail", reason: "max_attempts_exhausted", diagnostics };
  }

  // 3. Orphaned, resumable, within budget → resume.
  const diagnostics: RecoveryDiagnostics = {
    ...base,
    action: "resume",
    reason: "resumable",
    resumeAttempt,
    message: `Run was interrupted by a restart and resumed (attempt ${resumeAttempt}).`,
  };
  return { kind: "resume", diagnostics };
}
