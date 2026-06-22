/**
 * Rate-limit gate (issue #638) — graceful handling of external API rate limits so a run *slows down and
 * completes* instead of failing. A single shared gate fronts a provider; every request goes through
 * {@link RateLimitGate.run}, which:
 *
 *   1. **Paces** request *starts* at least `minIntervalMs` apart (steady-state spacing — stay under a
 *      provider's req/s ceiling), and
 *   2. **Cools down** on a 429: when an operation throws a `rate_limit` failure carrying `Retry-After`,
 *      the gate records a cooldown-until and *every* queued request — across all agents sharing this gate
 *      — waits past it before starting. One agent tripping the limit therefore throttles the whole fleet
 *      rather than letting them all keep hammering and failing.
 *
 * Requests serialise through a promise chain so the spacing/cooldown is computed one-at-a-time without
 * races; the operations themselves run as soon as they acquire a start slot. All non-determinism is
 * injected (`now`, `sleep`, `classify`) so the gate is unit-tested with a virtual clock and no real
 * waiting. Combine with {@link import("./execute.js").withRetry} to both *wait out* a 429 (backoff honours
 * Retry-After) and *throttle the fleet* (gate cooldown) — see the acceptance test.
 */

import { classifyFailure } from "./classify.js";
import type { FailureClass } from "./types.js";

export interface RateLimitGateOptions {
  /** Minimum spacing between request starts, in ms. `0` ⇒ no steady-state pacing (cooldown still applies). */
  readonly minIntervalMs?: number;
  /** Epoch-ms clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Sleep for `ms`. Defaults to a real `setTimeout`-backed sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Failure classifier (to detect a 429 + Retry-After on a thrown error). Defaults to {@link classifyFailure}. */
  readonly classify?: (error: unknown, nowMs: number) => FailureClass;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimitGate {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly classify: (error: unknown, nowMs: number) => FailureClass;

  /** Tail of the serialisation chain — each acquirer awaits the previous one's turn. */
  private tail: Promise<void> = Promise.resolve();
  /** When the most recent request started (for steady-state spacing). */
  private lastStartMs = Number.NEGATIVE_INFINITY;
  /** No request may start before this instant (set by a 429 Retry-After). */
  private cooldownUntilMs = Number.NEGATIVE_INFINITY;

  constructor(options: RateLimitGateOptions = {}) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 0);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.classify = options.classify ?? ((error, nowMs) => classifyFailure(error, { nowMs }));
  }

  /** The earliest instant a request may start, given spacing and any active cooldown. */
  private nextAllowedMs(): number {
    const afterSpacing = this.lastStartMs === Number.NEGATIVE_INFINITY ? this.now() : this.lastStartMs + this.minIntervalMs;
    return Math.max(afterSpacing, this.cooldownUntilMs);
  }

  /**
   * Extend the cooldown so no request starts for at least `retryAfterMs` from now. Idempotent and
   * monotonic — only ever pushes the cooldown later, never earlier. Exposed for callers that detect a
   * rate-limit out-of-band (e.g. from a response they inspect themselves).
   */
  noteRateLimited(retryAfterMs: number): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, this.now() + retryAfterMs);
  }

  /** Whether a cooldown is currently active (for diagnostics/tests). */
  isCoolingDown(): boolean {
    return this.now() < this.cooldownUntilMs;
  }

  /** Remaining cooldown in ms (0 when not cooling down) — for diagnostics/tests. */
  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntilMs - this.now());
  }

  /**
   * Acquire a start slot: wait my turn in the chain, then sleep until the gate permits a start (spacing +
   * cooldown), then claim the slot. Returns once the caller may run. Spacing between the *next* caller and
   * this one is enforced via `lastStartMs`, so the chain is released as soon as this start is stamped.
   */
  private async acquire(): Promise<void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const waitMs = this.nextAllowedMs() - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      this.lastStartMs = this.now();
    } finally {
      release();
    }
  }

  /**
   * Run `fn` through the gate. Waits for a paced/cooled-down start slot, runs `fn`, and — if `fn` throws a
   * `rate_limit` failure with a `Retry-After` — records the cooldown before re-throwing, so subsequent
   * requests through this gate back off too. Non-rate-limit errors pass straight through untouched.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } catch (error) {
      const failure = this.classify(error, this.now());
      if (failure.kind === "rate_limit" && failure.retryAfterMs !== null) {
        this.noteRateLimited(failure.retryAfterMs);
      }
      throw error;
    }
  }
}
