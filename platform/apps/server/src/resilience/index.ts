/**
 * Resilience module (issues #637 retry-with-backoff and #638 graceful rate-limit handling) — public
 * surface.
 *
 * A self-contained feature (the #635/#670/#674/#643 convention): it owns no table, reads config from the
 * environment (`caps.ts`), exposes no route, and touches no migration, schema barrel, or app-wiring
 * registry. Callers import two primitives and drive them:
 *
 *   - {@link withRetry} (#637) — wrap any idempotent external call so a transient 429/5xx/network blip is
 *     retried with exponential backoff + jitter (respecting `Retry-After`), capped in attempts and time,
 *     with every retry emitted to a {@link RetryObserver} so it is visible in the trace.
 *   - {@link RateLimitGate} (#638) — front a provider with a shared gate that paces request starts and,
 *     on a 429, cools the whole fleet down for `Retry-After` so runs slow down and complete rather than
 *     failing.
 *
 * The two compose: run each `withRetry` attempt through `gate.run(...)` and a single 429 both waits out the
 * provider (backoff) and throttles every other agent (cooldown). Wiring the gate/observer to the real
 * trace + external clients is a one-liner left to the integrator.
 */

export { classifyFailure, parseRetryAfterMs } from "./classify.js";
export { computeBackoff, type BackoffCaps } from "./backoff.js";
export {
  decideRetry,
  type RetryCaps,
  type RetryDecision,
  type DecideRetryInput,
  type GiveUpReason,
} from "./decide.js";
export {
  resolveResilienceCaps,
  RESILIENCE_DEFAULTS,
  type ResilienceCaps,
} from "./caps.js";
export {
  withRetry,
  RetryError,
  type WithRetryOptions,
} from "./execute.js";
export { RateLimitGate, type RateLimitGateOptions } from "./limiter.js";
export {
  NOOP_RETRY_OBSERVER,
  createLoggingObserver,
  type RetryObserver,
  type RetryEvent,
  type ResilienceLogger,
} from "./observer.js";
export type { FailureClass, FailureKind } from "./types.js";
