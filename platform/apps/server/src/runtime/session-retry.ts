import { nextBackoffMs } from "../durable-workflow/backoff.js";
import type { BackoffPolicy } from "../durable-workflow/types.js";

/**
 * #436 — bounded inline retry for a SPAWN-LAUNCH failure (the agent runtime threw before the process ever
 * produced output). This is the ONE failure class that is unconditionally safe to retry: `runtime.start()`
 * throwing means no process started, so no output was streamed, no heartbeat fired, no admission/markRunning
 * ran, and NO side effect (a money/deliverable action) could have happened — re-attempting cannot duplicate
 * work (#200 §4). A transient sandbox/ENOENT/cold-start hiccup is exactly this shape.
 *
 * Deliberately NARROW: it does NOT retry a process that started and then died (`wait()` → null exit) or a
 * stall/idle/timeout reap — those may have produced partial output or a real action, so retrying them risks
 * a double-ship. That broader, idempotency-guarded retry is a separate, integration-tested follow-up.
 *
 * Pure: no clock, no IO. `attempt` is 1-based (the attempt that just failed). Default OFF: `maxAttempts <= 1`
 * means a single attempt and no retry — byte-for-byte today's behavior.
 */

/**
 * Conservative default backoff for a spawn retry: exponential from 1s, factor 3, capped at 10s. `maxAttempts`
 * is part of the shared {@link BackoffPolicy} shape but unused for spawn-retry timing — the attempt ceiling
 * is the explicit `maxAttempts` argument to {@link decideSpawnRetry} (driven by `spawnRetryMaxAttempts`).
 */
export const DEFAULT_SPAWN_RETRY_BACKOFF: BackoffPolicy = { baseMs: 1000, factor: 3, capMs: 10_000, maxAttempts: 1 };

export interface SpawnRetryDecision {
  /** Re-attempt `runtime.start()`? */
  retry: boolean;
  /** How long to wait before the next attempt (0 when not retrying). */
  backoffMs: number;
}

export function decideSpawnRetry(
  attempt: number,
  maxAttempts: number,
  policy: BackoffPolicy = DEFAULT_SPAWN_RETRY_BACKOFF,
): SpawnRetryDecision {
  const max = Number.isFinite(maxAttempts) && maxAttempts > 1 ? Math.floor(maxAttempts) : 1;
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  if (n >= max) return { retry: false, backoffMs: 0 };
  return { retry: true, backoffMs: nextBackoffMs(n, policy) };
}
