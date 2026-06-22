/**
 * Pure exponential-backoff-with-jitter delay computation (issue #637). No IO, no clock, no implicit
 * randomness: the [0,1) source is injected (`rng`) so a test pins it and the result is deterministic.
 *
 * The classic "exponential backoff + full jitter" (AWS Architecture Blog): the uncapped delay for retry
 * `attempt` (1-based) is `baseMs * factor^(attempt-1)`, capped at `maxDelayMs`; full jitter then picks a
 * value uniformly in `[0, capped]`, which spreads a thundering herd of retrying callers across the window
 * instead of synchronising them on the same instant.
 *
 * A server-advised `Retry-After` (#638) is honoured as a *floor*: we never retry sooner than the provider
 * asked, even if the jittered delay came out smaller. The per-attempt `maxDelayMs` bounds the exponential
 * growth only — a large `Retry-After` is respected in full here, and the overall time budget is enforced
 * separately by the decision layer (`decide.ts`).
 */

/** Backoff shape: the exponential schedule plus the jitter strategy. */
export interface BackoffCaps {
  /** Delay floor for the first retry, in ms, before jitter (e.g. 200). */
  readonly baseMs: number;
  /** Exponential multiplier per attempt (e.g. 2 ⇒ doubling). */
  readonly factor: number;
  /** Per-attempt ceiling for the *exponential* term, in ms — bounds growth, not a server Retry-After. */
  readonly maxDelayMs: number;
  /** `full` ⇒ uniform jitter in `[0, capped]`; `none` ⇒ the capped value exactly (deterministic). */
  readonly jitter: "full" | "none";
}

/**
 * The delay, in ms, before retry `attempt` (1-based: `attempt === 1` is the first retry). `rng` must
 * return a value in `[0, 1)`. `serverRetryAfterMs`, when present, is a hard floor. Result is a finite
 * non-negative integer.
 */
export function computeBackoff(
  attempt: number,
  caps: BackoffCaps,
  rng: () => number,
  serverRetryAfterMs: number | null = null,
): number {
  const n = Math.max(1, Math.trunc(attempt));
  // Exponential term, guarded against overflow to Infinity for large attempt counts.
  const exponential = caps.baseMs * Math.pow(caps.factor, n - 1);
  const capped = Math.min(caps.maxDelayMs, Number.isFinite(exponential) ? exponential : caps.maxDelayMs);

  let delay: number;
  if (caps.jitter === "full") {
    const r = Math.min(Math.max(rng(), 0), 1); // clamp a misbehaving rng into [0,1]
    delay = r * capped;
  } else {
    delay = capped;
  }

  if (serverRetryAfterMs !== null && serverRetryAfterMs > delay) {
    delay = serverRetryAfterMs;
  }
  return Math.max(0, Math.round(delay));
}
