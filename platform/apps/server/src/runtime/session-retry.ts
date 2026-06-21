import { nextBackoffMs } from "../durable-workflow/backoff.js";
import type { BackoffPolicy } from "../durable-workflow/types.js";
import type { SessionStatus } from "./types.js";

/**
 * #436 — bounded inline retry for a transient, PRE-PROGRESS session death.
 *
 * The runtime had zero inline retry: a transient harness death — `runtime.start()` throwing (spawn
 * ENOENT / cold-start hiccup) or a process that started and immediately died returning a `null` exit
 * code — was finalized `failed` once and never re-attempted. The only retry was the #105 watchdog
 * revival, default-OFF in prod, so transient deaths got no automatic retry at all and inflated the
 * fail rate (#394). This module is the pure, tested decision core that fixes that.
 *
 * The ONE rule that makes a retry safe (#200 §4 idempotency): re-run ONLY when the dead attempt
 * produced **no output and no heartbeat**. A `start()` throw means no process ran. A `wait()` → null
 * exit with no output/heartbeat means the process died before it streamed a single byte — so no
 * admission action, no deliverable, no money/real action could have landed, and re-attempting cannot
 * duplicate work. The instant ANY output or heartbeat is seen, the attempt may have taken a real
 * action, so it is NEVER retried — it fails honestly and routes to self-healing as before.
 *
 * Deliberately NARROW on the failure shape too: only a `failed` status with a `null` exit code is
 * retryable (the spawn/null-exit class). A `timeout`/`idle_reaped` reap is excluded (the process ran
 * for a while — retrying risks re-running real work and #436 lists it non-retryable); `canceled` is
 * intentional; a non-null exit code is a real run that produced a real failure. Those all fail once.
 *
 * Pure: no clock, no IO. `attempt` is 1-based (the attempt that just failed). Default OFF:
 * `maxAttempts <= 1` ⇒ a single attempt, no retry — byte-for-byte today's behavior.
 */

/**
 * Conservative default backoff for a session retry: exponential from 1s, factor 3, capped at 10s.
 * `maxAttempts` is part of the shared {@link BackoffPolicy} shape but unused for retry-timing here —
 * the attempt ceiling is the explicit `maxAttempts` argument (driven by `sessionRetryMaxAttempts`).
 */
export const DEFAULT_SESSION_RETRY_BACKOFF: BackoffPolicy = { baseMs: 1000, factor: 3, capMs: 10_000, maxAttempts: 1 };

/** Back-compat alias — the original #435 narrow spawn-retry backoff is the same conservative shape. */
export const DEFAULT_SPAWN_RETRY_BACKOFF = DEFAULT_SESSION_RETRY_BACKOFF;

/** Why a retry decision came out the way it did — surfaced in logs so a non-retry is never silent. */
export type SessionRetryReason = "retry" | "off" | "exhausted" | "progress" | "non-retryable";

export interface SessionRetryInput {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Hard attempt ceiling; `<= 1` ⇒ retry is OFF (today's behavior). */
  maxAttempts: number;
  /** The dead attempt's terminal status. */
  status: SessionStatus;
  /** The dead attempt's exit code (`null` ⇒ the process never returned one — the retryable shape). */
  exitCode: number | null;
  /** Did the SESSION emit ANY output across its attempts? If so, never retry (it may have acted). */
  sawOutput: boolean;
  /** Did a liveness heartbeat fire? Same idempotency guard as {@link sawOutput}. */
  sawHeartbeat: boolean;
  /** Backoff schedule for the wait between attempts. */
  policy?: BackoffPolicy;
}

export interface SessionRetryDecision {
  /** Re-attempt the full start→wait cycle? */
  retry: boolean;
  /** How long to wait before the next attempt (0 when not retrying). */
  backoffMs: number;
  /** The reason this decision was reached (for structured logging). */
  reason: SessionRetryReason;
}

/**
 * Decide whether a just-failed session attempt may be retried, and how long to back off first.
 * See the module doc for the full safety argument. Total + pure ⇒ exhaustively unit-tested.
 */
export function decideSessionRetry(input: SessionRetryInput): SessionRetryDecision {
  const policy = input.policy ?? DEFAULT_SESSION_RETRY_BACKOFF;
  const max = Number.isFinite(input.maxAttempts) && input.maxAttempts > 1 ? Math.floor(input.maxAttempts) : 1;
  const n = Number.isFinite(input.attempt) && input.attempt >= 1 ? Math.floor(input.attempt) : 1;

  // Default OFF — a single attempt, no retry.
  if (max <= 1) return { retry: false, backoffMs: 0, reason: "off" };
  // Idempotency guard (#200 §4): any output/heartbeat means a real action may have landed — never re-run.
  if (input.sawOutput || input.sawHeartbeat) return { retry: false, backoffMs: 0, reason: "progress" };
  // Only a clean pre-progress death is retryable: a `failed` status with a null exit code.
  if (!(input.status === "failed" && input.exitCode === null)) {
    return { retry: false, backoffMs: 0, reason: "non-retryable" };
  }
  // Bounded — never loops forever.
  if (n >= max) return { retry: false, backoffMs: 0, reason: "exhausted" };
  return { retry: true, backoffMs: nextBackoffMs(n, policy), reason: "retry" };
}

/**
 * Back-compat shim for the original #435 narrow spawn-launch retry: `runtime.start()` throwing is, by
 * construction, a pre-progress death (no process ran), so it reduces to {@link decideSessionRetry} with
 * `status: "failed"`, `exitCode: null`, and no output/heartbeat. Kept so existing call sites and the
 * `AGENT_SPAWN_RETRY_MAX_ATTEMPTS` env knob behave identically.
 */
export function decideSpawnRetry(
  attempt: number,
  maxAttempts: number,
  policy: BackoffPolicy = DEFAULT_SESSION_RETRY_BACKOFF,
): { retry: boolean; backoffMs: number } {
  const d = decideSessionRetry({
    attempt,
    maxAttempts,
    status: "failed",
    exitCode: null,
    sawOutput: false,
    sawHeartbeat: false,
    policy,
  });
  return { retry: d.retry, backoffMs: d.backoffMs };
}
