/**
 * Crash/restart run-recovery module (issue #643) — public surface.
 *
 * A self-contained feature (the #635/#670/#674 convention): owns its own table (`default.ts`), reads
 * config from the environment (`caps.ts`), and exposes no route — callers import the service and drive it
 * (startRun/setResumable/heartbeat/completeRun) stamping each run with this process's instance id, plus a
 * one-shot {@link RunRecoveryService.recover} on boot that resumes resumable orphaned runs and cleanly
 * fails the rest, reconciling their worktrees/locks. Wiring it to the boot sequence + worktree/lock APIs
 * is a one-liner left to the integrator, so this change touches no migration, schema barrel, or app-wiring
 * registry.
 */

export { decideRecovery, type RecoveryContext, type RecoveryDecision } from "./decide.js";
export {
  RunRecoveryService,
  RunRecoveryError,
  type RunRecoveryServiceOptions,
  type RecoveryResult,
  type ResumedRun,
  type FailedRun,
} from "./service.js";
export { InMemoryRunRecoveryStore, type RunRecoveryStore } from "./store.js";
export {
  createRunReconciler,
  NOOP_RUN_RECONCILER,
  type ReconcileHandle,
  type ReconcileLogger,
  type ReconcileOutcome,
  type RunReconciler,
  type RunReconcilerOptions,
} from "./reconcile.js";
export {
  resolveRunRecoveryCaps,
  resolveInstanceId,
  RUN_RECOVERY_DEFAULTS,
  DEFAULT_MAX_RESUME_ATTEMPTS,
  type RunRecoveryCaps,
} from "./caps.js";
export {
  createDefaultRunRecoveryService,
  PgRunRecoveryStore,
} from "./default.js";
export {
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
  type FailureReason,
  type RecoveryAction,
  type RecoveryDiagnostics,
  type RunRecord,
  type RunRecordPatch,
  type RunStatus,
  type StartRunInput,
} from "./types.js";
