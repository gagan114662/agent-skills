/**
 * Worktree/lock reconciliation seam for run recovery (issue #643). The acceptance criterion is not just
 * "mark the run resumed/failed" but "reconcile worktrees/locks so state is consistent". Two shapes of
 * reconciliation:
 *
 *   - **release** (a run being *failed*): drop the git worktree it was holding and release any lock /
 *     scheduler lease, so a crash-orphaned run can't leak a worktree (cf. #636) or wedge a single-leader
 *     job forever.
 *   - **reconcile** (a run being *resumed*): make the worktree usable again under the new owner — ensure
 *     it exists and is clean (a crash can leave a stale `index.lock` or a half-applied checkout) and
 *     re-acquire the lock for the live instance, so the resumed run starts from consistent state.
 *
 * This module owns NO resources itself: it is a seam the recovery service calls, with the concrete
 * functions injected by whoever wires the service up. We keep it a seam (rather than importing
 * `worktree-pool/service.ts` and `scheduler/*` directly) so the #643 change set stays self-contained and
 * collision-free, and so the service is unit-testable with a recording fake. The intended production
 * wiring is a one-liner shaped to match those existing APIs.
 *
 * Every reconciliation is **best-effort**: each individual step is wrapped so a failure is captured in the
 * outcome rather than thrown. Recovering a run must never be blocked by a flaky cleanup — a worktree that
 * can't be reconciled now is reaped later by the orphan sweep (#70); a lock that can't be re-acquired
 * surfaces in `errors` for the integrator to decide on.
 */

import type { RecoveryAction } from "./types.js";

/** What the service knows about a run when it asks for reconciliation. */
export interface ReconcileHandle {
  runId: string;
  workspaceId: string;
  /** The session whose worktree to reconcile/release, or null if the run held none. */
  sessionId: string | null;
  /** The lock / scheduler-lease key to reconcile/release, or null if the run held none. */
  lockKey: string | null;
  /** Whether the run is being resumed or failed. */
  action: RecoveryAction;
}

/** The outcome of a best-effort reconciliation — what was handled and what failed (never throws). */
export interface ReconcileOutcome {
  /** The worktree was reconciled (resume) or released (fail). False if none held or it failed. */
  worktreeReconciled: boolean;
  /** The lock was re-acquired (resume) or released (fail). False if none held or it failed. */
  lockReconciled: boolean;
  /** Human-readable messages for any step that failed. Empty when everything succeeded (or nothing was held). */
  errors: string[];
}

export interface RunReconciler {
  /** Reconcile a run's worktree + lock so a resumed run starts from consistent state. */
  reconcile(handle: ReconcileHandle): Promise<ReconcileOutcome>;
  /** Release a failed run's worktree + lock so nothing leaks. */
  release(handle: ReconcileHandle): Promise<ReconcileOutcome>;
}

/** Optional sink for diagnostics — a subset of Fastify's logger, so the real `app.log` drops in. */
export interface ReconcileLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface RunReconcilerOptions {
  /** Ensure a resumed run's worktree exists and is clean (e.g. `(sessionId) => worktreePool.ensureClean(sessionId)`). */
  ensureWorktree?: (sessionId: string) => Promise<void>;
  /** Re-acquire a resumed run's lock under the live instance (e.g. `(key) => scheduler.acquire(key)`). */
  acquireLock?: (lockKey: string) => Promise<void>;
  /** Release a failed run's git worktree (e.g. `(sessionId) => worktreePool.release(sessionId)`). */
  releaseWorktree?: (sessionId: string) => Promise<void>;
  /** Release a failed run's lock / scheduler lease (e.g. `(key) => scheduler.complete(key)`). */
  releaseLock?: (lockKey: string) => Promise<void>;
  /** Optional logger for best-effort-reconcile failures. */
  log?: ReconcileLogger;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run one best-effort step: invoke `fn` if both the resource and the function are present; capture any throw. */
async function step(
  fn: ((arg: string) => Promise<void>) | undefined,
  arg: string | null,
  describe: (arg: string) => string,
  errors: string[],
  log: ReconcileLogger | undefined,
  logCtx: Record<string, unknown>,
): Promise<boolean> {
  if (arg === null || !fn) return false;
  try {
    await fn(arg);
    return true;
  } catch (e) {
    const message = `${describe(arg)}: ${errMessage(e)}`;
    errors.push(message);
    log?.warn(logCtx, `[run-recovery] ${message}`);
    return false;
  }
}

/**
 * Build a {@link RunReconciler} from concrete functions. A handle with a `null` sessionId / lockKey, or a
 * reconciler with the matching function omitted, simply skips that resource (counts as "not held", not an
 * error). Each step is independently best-effort: one failing never prevents the other.
 */
export function createRunReconciler(options: RunReconcilerOptions = {}): RunReconciler {
  const { ensureWorktree, acquireLock, releaseWorktree, releaseLock, log } = options;
  return {
    async reconcile(handle: ReconcileHandle): Promise<ReconcileOutcome> {
      const errors: string[] = [];
      const worktreeReconciled = await step(
        ensureWorktree,
        handle.sessionId,
        (id) => `worktree reconcile failed for session ${id}`,
        errors,
        log,
        { runId: handle.runId, sessionId: handle.sessionId },
      );
      const lockReconciled = await step(
        acquireLock,
        handle.lockKey,
        (key) => `lock re-acquire failed for ${key}`,
        errors,
        log,
        { runId: handle.runId, lockKey: handle.lockKey },
      );
      return { worktreeReconciled, lockReconciled, errors };
    },

    async release(handle: ReconcileHandle): Promise<ReconcileOutcome> {
      const errors: string[] = [];
      const worktreeReconciled = await step(
        releaseWorktree,
        handle.sessionId,
        (id) => `worktree release failed for session ${id}`,
        errors,
        log,
        { runId: handle.runId, sessionId: handle.sessionId },
      );
      const lockReconciled = await step(
        releaseLock,
        handle.lockKey,
        (key) => `lock release failed for ${key}`,
        errors,
        log,
        { runId: handle.runId, lockKey: handle.lockKey },
      );
      return { worktreeReconciled, lockReconciled, errors };
    },
  };
}

/** A reconciler that touches nothing — the default when no wiring is supplied (the pass still transitions state). */
export const NOOP_RUN_RECONCILER: RunReconciler = {
  async reconcile(): Promise<ReconcileOutcome> {
    return { worktreeReconciled: false, lockReconciled: false, errors: [] };
  },
  async release(): Promise<ReconcileOutcome> {
    return { worktreeReconciled: false, lockReconciled: false, errors: [] };
  },
};
