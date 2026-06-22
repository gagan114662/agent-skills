/**
 * Crash/restart run-recovery service (issue #643). The IO shell around the pure {@link decideRecovery}
 * core. Two responsibilities:
 *
 *   1. **Lifecycle tracking** — record a run as `running` stamped with this process's instance id, let it
 *      flip its `resumable` flag and heartbeat as it progresses, and finish it gracefully. The instance
 *      stamp is what makes a crash detectable: after a restart, a still-`running` run carries the *dead*
 *      instance's id, so the new process can tell it apart from runs it is itself driving.
 *   2. **Recovery** — the heart of the fix: on boot, {@link RunRecoveryService.recover} sweeps every
 *      orphaned run (still `running`, owned by a dead instance) and, per the pure decision, either
 *      *resumes* it (re-owns under this instance, bumps the attempt count, reconciles its worktree/lock so
 *      it can be re-driven) or *fails* it with a clear reason (freeing the worktree/lock it held). The
 *      result hands the integrator the runs to re-drive and the runs that were failed.
 *
 * `recover` is a one-shot startup pass (not a periodic sweep): run it once after the store is reachable
 * and before the process starts accepting new runs. It is also idempotent — a run this instance has
 * already re-owned is skipped by the pure core, so a double-invoke never double-recovers. All time comes
 * from the injected `now()` and all persistence from the injected store, so the service is unit-tested
 * with no clock, no boot, and no DB.
 */

import { decideRecovery, type RecoveryContext } from "./decide.js";
import { NOOP_RUN_RECONCILER, type ReconcileOutcome, type RunReconciler } from "./reconcile.js";
import type { RunRecoveryStore } from "./store.js";
import { resolveRunRecoveryCaps, type RunRecoveryCaps } from "./caps.js";
import {
  isTerminalRunStatus,
  type RecoveryDiagnostics,
  type RunRecord,
  type RunStatus,
  type StartRunInput,
} from "./types.js";

/** Error thrown for invalid lifecycle calls (e.g. completing a run that isn't tracked). */
export class RunRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRecoveryError";
  }
}

/** One run the recovery pass resumed (re-owned under this instance), with why and what was reconciled. */
export interface ResumedRun {
  record: RunRecord;
  diagnostics: RecoveryDiagnostics;
  reconcile: ReconcileOutcome;
}

/** One run the recovery pass failed (could not resume), with why and what was released. */
export interface FailedRun {
  record: RunRecord;
  diagnostics: RecoveryDiagnostics;
  release: ReconcileOutcome;
}

/** The result of one recovery pass. */
export interface RecoveryResult {
  /** How many orphaned runs were examined. */
  scanned: number;
  /** The runs this pass resumed (newly re-owned), in store order — hand these back to be re-driven. */
  resumed: ResumedRun[];
  /** The runs this pass failed (not resumable / budget exhausted), in store order. */
  failed: FailedRun[];
}

export interface RunRecoveryServiceOptions {
  store: RunRecoveryStore;
  /** This process's unique instance id — stamped on every run started here and the live id for recovery. */
  instanceId: string;
  /** Reconciles a recovered run's resources. Defaults to {@link NOOP_RUN_RECONCILER} (state-only pass). */
  reconciler?: RunReconciler;
  /** Config caps; resolved from the environment when omitted. */
  caps?: RunRecoveryCaps;
  /** Epoch-ms clock; defaults to `Date.now`. Injected for deterministic tests. */
  now?: () => number;
}

export class RunRecoveryService {
  private readonly store: RunRecoveryStore;
  private readonly instanceId: string;
  private readonly reconciler: RunReconciler;
  private readonly caps: RunRecoveryCaps;
  private readonly now: () => number;

  constructor(options: RunRecoveryServiceOptions) {
    this.store = options.store;
    this.instanceId = options.instanceId;
    this.reconciler = options.reconciler ?? NOOP_RUN_RECONCILER;
    this.caps = options.caps ?? resolveRunRecoveryCaps();
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether the recovery pass is enabled (master switch). */
  isEnabled(): boolean {
    return this.caps.enabled;
  }

  /** The configured caps (read-only). */
  getCaps(): RunRecoveryCaps {
    return { ...this.caps };
  }

  /** This process's instance id (stamped on runs started here). */
  getInstanceId(): string {
    return this.instanceId;
  }

  /** Begin tracking a run, stamped with this instance as owner. `resumable` defaults to false. */
  async startRun(input: StartRunInput): Promise<RunRecord> {
    const startedAtMs = this.now();
    const record: RunRecord = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? null,
      lockKey: input.lockKey ?? null,
      ownerInstanceId: this.instanceId,
      status: "running",
      resumable: input.resumable ?? false,
      startedAtMs,
      lastHeartbeatAtMs: startedAtMs,
      resumeAttempts: 0,
      lastRecoveredAtMs: null,
      endedAtMs: null,
      failureReason: null,
      recovery: null,
    };
    return this.store.insert(record);
  }

  /** Flip a run's resumable flag (e.g. once it has written a checkpoint). No-op if the run is terminal. */
  async setResumable(runId: string, resumable: boolean): Promise<RunRecord | null> {
    const record = await this.requireRunning(runId);
    if (!record) return null;
    return this.store.patch(runId, { resumable });
  }

  /** Record progress (bumps the heartbeat). No-op if the run is already terminal. */
  async heartbeat(runId: string): Promise<RunRecord | null> {
    const record = await this.requireRunning(runId);
    if (!record) return null;
    return this.store.patch(runId, { lastHeartbeatAtMs: this.now() });
  }

  /** Finish a run gracefully. `status` must be a terminal state. Returns null if it isn't running. */
  async completeRun(runId: string, status: Extract<RunStatus, "completed" | "failed">): Promise<RunRecord | null> {
    const record = await this.store.getByRunId(runId);
    if (!record) throw new RunRecoveryError(`run ${runId} is not tracked`);
    if (isTerminalRunStatus(record.status)) return null;
    return this.store.patch(runId, { status, endedAtMs: this.now() });
  }

  /** Load one run within a workspace (#3 IDOR scoping). */
  async getRun(workspaceId: string, runId: string): Promise<RunRecord | null> {
    return this.store.get(workspaceId, runId);
  }

  /** A workspace's tracked runs, newest first. */
  async listRuns(workspaceId: string): Promise<RunRecord[]> {
    return this.store.listByWorkspace(workspaceId);
  }

  /**
   * One-shot boot recovery: examine every orphaned run (still `running`, owned by a dead instance) and,
   * per the pure decision, resume it (re-own under this instance + reconcile worktree/lock) or fail it
   * with a reason (releasing its worktree/lock). A disabled pass does nothing. Idempotent: a run this
   * instance already re-owns is no longer orphaned, so a second pass never re-recovers it.
   */
  async recover(): Promise<RecoveryResult> {
    if (!this.caps.enabled) return { scanned: 0, resumed: [], failed: [] };

    const orphaned = await this.store.listOrphaned(this.instanceId);
    const nowMs = this.now();
    const ctx: RecoveryContext = {
      instanceId: this.instanceId,
      nowMs,
      maxResumeAttempts: this.caps.maxResumeAttempts,
    };
    const resumed: ResumedRun[] = [];
    const failed: FailedRun[] = [];

    for (const record of orphaned) {
      const decision = decideRecovery(record, ctx);
      // `listOrphaned` already excludes terminal + this-instance-owned runs; the pure core also skips
      // them defensively, so a record that races into a skip is simply ignored here.
      if (decision.kind === "skip") continue;

      if (decision.kind === "resume") {
        const patched = await this.store.patch(record.runId, {
          ownerInstanceId: this.instanceId,
          resumeAttempts: record.resumeAttempts + 1,
          lastRecoveredAtMs: nowMs,
          recovery: decision.diagnostics,
        });
        if (!patched) continue;
        const reconcile = await this.reconciler.reconcile({
          runId: patched.runId,
          workspaceId: patched.workspaceId,
          sessionId: patched.sessionId,
          lockKey: patched.lockKey,
          action: "resume",
        });
        resumed.push({ record: patched, diagnostics: decision.diagnostics, reconcile });
        continue;
      }

      // decision.kind === "fail"
      const patched = await this.store.patch(record.runId, {
        status: "failed",
        endedAtMs: nowMs,
        failureReason: decision.reason,
        recovery: decision.diagnostics,
      });
      if (!patched) continue;
      const release = await this.reconciler.release({
        runId: patched.runId,
        workspaceId: patched.workspaceId,
        sessionId: patched.sessionId,
        lockKey: patched.lockKey,
        action: "fail",
      });
      failed.push({ record: patched, diagnostics: decision.diagnostics, release });
    }

    return { scanned: orphaned.length, resumed, failed };
  }

  /** Load a run by id, returning null when it's missing or already terminal (so lifecycle bumps no-op). */
  private async requireRunning(runId: string): Promise<RunRecord | null> {
    const record = await this.store.getByRunId(runId);
    if (!record || isTerminalRunStatus(record.status)) return null;
    return record;
  }
}
