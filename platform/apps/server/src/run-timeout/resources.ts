/**
 * Resource-release seam for run timeouts (issue #635). The acceptance criterion is not just "mark the
 * run timed_out" but "free its resources" — release the git worktree the run was holding and drop any
 * lock / scheduler lease, so a hung run can't exhaust the worktree pool (cf. the leak in #636) or wedge
 * a single-leader job forever.
 *
 * This module owns NO resources itself: it is a seam the timeout service calls, with the concrete
 * release functions injected by whoever wires the service up. We keep it a seam (rather than importing
 * `worktree-pool/service.ts` and `scheduler/*` directly) so the #635 change set stays self-contained and
 * collision-free, and so the service is unit-testable with a recording fake. The intended production
 * wiring is a one-liner — `createResourceReleaser({ releaseWorktree: (id) => worktreePool.release(id),
 * releaseLock: (key) => scheduler.complete(...) })` — shaped to match those existing APIs.
 *
 * Release is **best-effort**: every individual release is wrapped so a failure is captured in the
 * outcome rather than thrown. Finalizing a timed-out run must never be blocked by a flaky cleanup —
 * a worktree that can't be released now is reaped later by the orphan sweep (#70).
 */

import type { TimeoutKind } from "./types.js";

/** What the service knows about a timed-out run when it asks for cleanup. */
export interface ReleaseHandle {
  runId: string;
  workspaceId: string;
  /** The session whose worktree to release, or null if the run held none. */
  sessionId: string | null;
  /** The lock / scheduler-lease key to release, or null if the run held none. */
  lockKey: string | null;
  /** Why the run is being torn down. */
  reason: TimeoutKind;
}

/** The outcome of a best-effort release — what was freed and what failed (never throws). */
export interface ReleaseOutcome {
  worktreeReleased: boolean;
  lockReleased: boolean;
  /** Human-readable messages for any release that failed. Empty when everything succeeded (or nothing was held). */
  errors: string[];
}

export interface ResourceReleaser {
  release(handle: ReleaseHandle): Promise<ReleaseOutcome>;
}

/** Optional sink for diagnostics — a subset of Fastify's logger, so the real `app.log` drops in. */
export interface ReleaseLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ResourceReleaserOptions {
  /** Release the run's git worktree (e.g. `(sessionId) => worktreePool.release(sessionId)`). */
  releaseWorktree?: (sessionId: string) => Promise<void>;
  /** Release the run's lock / scheduler lease (e.g. `(key) => scheduler.complete({ jobKey: key, ... })`). */
  releaseLock?: (lockKey: string) => Promise<void>;
  /** Optional logger for best-effort-release failures. */
  log?: ReleaseLogger;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build a {@link ResourceReleaser} from concrete release functions. A handle with a `null` sessionId /
 * lockKey, or a releaser with the matching function omitted, simply skips that resource (counts as "not
 * held", not an error). Each release is independently best-effort: one failing never prevents the other.
 */
export function createResourceReleaser(options: ResourceReleaserOptions = {}): ResourceReleaser {
  const { releaseWorktree, releaseLock, log } = options;
  return {
    async release(handle: ReleaseHandle): Promise<ReleaseOutcome> {
      const errors: string[] = [];
      let worktreeReleased = false;
      let lockReleased = false;

      if (handle.sessionId !== null && releaseWorktree) {
        try {
          await releaseWorktree(handle.sessionId);
          worktreeReleased = true;
        } catch (e) {
          const message = `worktree release failed for session ${handle.sessionId}: ${errMessage(e)}`;
          errors.push(message);
          log?.warn({ runId: handle.runId, sessionId: handle.sessionId }, `[run-timeout] ${message}`);
        }
      }

      if (handle.lockKey !== null && releaseLock) {
        try {
          await releaseLock(handle.lockKey);
          lockReleased = true;
        } catch (e) {
          const message = `lock release failed for ${handle.lockKey}: ${errMessage(e)}`;
          errors.push(message);
          log?.warn({ runId: handle.runId, lockKey: handle.lockKey }, `[run-timeout] ${message}`);
        }
      }

      return { worktreeReleased, lockReleased, errors };
    },
  };
}

/** A releaser that frees nothing — the default when no cleanup wiring is supplied (sweeper still transitions state). */
export const NOOP_RESOURCE_RELEASER: ResourceReleaser = {
  async release(): Promise<ReleaseOutcome> {
    return { worktreeReleased: false, lockReleased: false, errors: [] };
  },
};
