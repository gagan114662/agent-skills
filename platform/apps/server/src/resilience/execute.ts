/**
 * Retry orchestrator (issue #637) — the IO shell around the pure {@link decideRetry} core. Runs an
 * idempotent operation and, on a *transient* failure (429/5xx/network — see `classify.ts`), waits an
 * exponential-backoff-with-jitter delay that respects any server `Retry-After`, then tries again, up to a
 * capped number of attempts and total time. A transient blip is absorbed and the run continues; a
 * permanent error, an exhausted budget, or a non-idempotent operation is re-thrown unchanged so the caller
 * sees the real failure.
 *
 * All non-determinism is injected — the clock (`now`), the sleep (`sleep`), the jitter source (`rng`), and
 * the classifier (`classify`) — so the orchestrator is unit-tested with a virtual clock and no real
 * waiting. Every lifecycle moment is emitted to the {@link RetryObserver} (default no-op) so the retry is
 * "visible in the trace" (#637).
 *
 * Idempotency is the caller's contract: pass `idempotent: false` for an operation that must not be
 * repeated (e.g. a non-idempotent POST) and it will never be retried, even on a transient failure.
 */

import { classifyFailure } from "./classify.js";
import { decideRetry, type RetryCaps } from "./decide.js";
import { NOOP_RETRY_OBSERVER, type RetryObserver } from "./observer.js";
import { RESILIENCE_DEFAULTS } from "./caps.js";
import type { FailureClass } from "./types.js";

/** Thrown when a non-idempotent operation hits a transient failure: clearer than a bare classify result. */
export class RetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryError";
  }
}

export interface WithRetryOptions {
  /** Label for the operation, surfaced on every observer event (so the trace shows which call retried). */
  readonly operation: string;
  /** The retry policy. Defaults to {@link RESILIENCE_DEFAULTS}.retry but `enabled: true`. */
  readonly caps?: RetryCaps & { readonly enabled?: boolean };
  /** Whether the operation is safe to repeat. Defaults to `true`. `false` ⇒ never retried. */
  readonly idempotent?: boolean;
  /** Observability sink. Defaults to {@link NOOP_RETRY_OBSERVER}. */
  readonly observer?: RetryObserver;
  /** Epoch-ms clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Sleep for `ms`. Defaults to a real `setTimeout`-backed sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** [0,1) jitter source. Defaults to `Math.random`. */
  readonly rng?: () => number;
  /** Failure classifier. Defaults to {@link classifyFailure} (with the current clock for date Retry-After). */
  readonly classify?: (error: unknown, nowMs: number) => FailureClass;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The default retry policy: the shared defaults, but switched on (an explicit `withRetry` call opts in). */
const DEFAULT_ENABLED_CAPS: RetryCaps & { enabled: boolean } = { ...RESILIENCE_DEFAULTS.retry, enabled: true };

/**
 * Run `fn` with retry-on-transient-failure. `fn` receives the 1-based attempt number. Returns `fn`'s
 * resolved value as soon as an attempt succeeds; re-throws the last error if retries are disabled, the
 * failure is permanent/non-idempotent, or the attempt/time budget is exhausted.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: WithRetryOptions): Promise<T> {
  const {
    operation,
    caps = DEFAULT_ENABLED_CAPS,
    idempotent = true,
    observer = NOOP_RETRY_OBSERVER,
    now = Date.now,
    sleep = realSleep,
    rng = Math.random,
    classify = (error, nowMs) => classifyFailure(error, { nowMs }),
  } = options;

  const enabled = caps.enabled ?? true;
  const startMs = now();
  let attempt = 1;

  // Fast path: retries off ⇒ run exactly once, preserving today's behaviour.
  if (!enabled) {
    observer.onEvent({ type: "attempt", operation, attempt });
    const result = await fn(attempt);
    observer.onEvent({ type: "success", operation, attempt });
    return result;
  }

  for (;;) {
    observer.onEvent({ type: "attempt", operation, attempt });
    try {
      const result = await fn(attempt);
      observer.onEvent({ type: "success", operation, attempt });
      return result;
    } catch (error) {
      const failure = classify(error, now());
      const decision = decideRetry({
        failure,
        attempt,
        elapsedMs: now() - startMs,
        idempotent,
        caps,
        rng,
      });

      if (decision.action === "give_up") {
        observer.onEvent({ type: "give_up", operation, attempt, reason: decision.reason, failure });
        throw error;
      }

      observer.onEvent({
        type: "retry",
        operation,
        attempt,
        nextAttempt: decision.nextAttempt,
        delayMs: decision.delayMs,
        failure,
      });
      await sleep(decision.delayMs);
      attempt = decision.nextAttempt;
    }
  }
}
