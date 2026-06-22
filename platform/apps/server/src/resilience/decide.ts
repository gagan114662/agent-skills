/**
 * Pure retry decision (issue #637). Given a classified failure, which attempt just failed, how much time
 * has elapsed, whether the operation is idempotent, and the caps, decide whether to retry (and after how
 * long) or give up (and why). No IO, no clock — the IO shell (`execute.ts`) does the sleeping and the
 * clock-reading around this.
 *
 * Give-up precedence (highest first), so the reported reason is always the most fundamental one:
 *   1. `permanent`        — the failure isn't transient; retrying cannot help.
 *   2. `not_idempotent`   — a transient failure, but the operation isn't safe to repeat (a retry could
 *                           double-submit). #637 is explicit that retries are *idempotent* retries.
 *   3. `exhausted_attempts` — the attempt budget is spent.
 *   4. `exhausted_time`   — retrying would push past the total time budget.
 * Otherwise: `retry` after a backoff that respects any server `Retry-After` (#638).
 */

import { computeBackoff, type BackoffCaps } from "./backoff.js";
import type { FailureClass } from "./types.js";

/** The full retry policy: the backoff schedule plus the attempt and time budgets. */
export interface RetryCaps extends BackoffCaps {
  /**
   * Total attempts allowed, *including the first try*. `maxAttempts === 1` ⇒ never retry; `4` ⇒ one try
   * plus up to three retries. The cap (#637: "capped") stops a persistently-failing call from looping.
   */
  readonly maxAttempts: number;
  /** Overall wall-clock budget across all attempts, in ms. A retry whose delay would exceed it is refused. */
  readonly maxElapsedMs: number;
}

export type GiveUpReason = "permanent" | "not_idempotent" | "exhausted_attempts" | "exhausted_time";

export type RetryDecision =
  | { readonly action: "retry"; readonly delayMs: number; readonly nextAttempt: number; readonly failure: FailureClass }
  | { readonly action: "give_up"; readonly reason: GiveUpReason; readonly failure: FailureClass };

export interface DecideRetryInput {
  /** The classified failure that just occurred. */
  readonly failure: FailureClass;
  /** The attempt number that just failed (1-based). */
  readonly attempt: number;
  /** Wall-clock ms elapsed since the first attempt began. */
  readonly elapsedMs: number;
  /** Whether the operation is safe to repeat. A non-idempotent op is never retried. */
  readonly idempotent: boolean;
  readonly caps: RetryCaps;
  /** [0,1) source for jitter. */
  readonly rng: () => number;
}

/**
 * Decide what to do after attempt `attempt` failed. Returns `retry` with the delay to wait and the next
 * attempt number, or `give_up` with the precedence-ordered reason. Pure and total.
 */
export function decideRetry(input: DecideRetryInput): RetryDecision {
  const { failure, attempt, elapsedMs, idempotent, caps, rng } = input;

  if (!failure.transient) return { action: "give_up", reason: "permanent", failure };
  if (!idempotent) return { action: "give_up", reason: "not_idempotent", failure };
  if (attempt >= caps.maxAttempts) return { action: "give_up", reason: "exhausted_attempts", failure };

  const delayMs = computeBackoff(attempt, caps, rng, failure.retryAfterMs);
  if (elapsedMs + delayMs > caps.maxElapsedMs) {
    return { action: "give_up", reason: "exhausted_time", failure };
  }
  return { action: "retry", delayMs, nextAttempt: attempt + 1, failure };
}
