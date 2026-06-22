/**
 * Shared types for the resilience module (issues #637 retry-with-backoff and #638 graceful rate-limit
 * handling). Kept dependency-free so the pure cores (`classify`/`backoff`/`decide`) and the IO shells
 * (`execute`/`limiter`) share one vocabulary without importing each other's machinery.
 */

/**
 * The category a failure falls into for retry purposes.
 *   - `rate_limit` — the provider told us to slow down (HTTP 429). Transient; usually carries a Retry-After.
 *   - `server`     — a server-side error (HTTP 5xx). Transient; the same request may succeed shortly.
 *   - `network`    — a connection-level fault (reset/refused/DNS-temporary). Transient.
 *   - `timeout`    — the request timed out (HTTP 408/425 or a client deadline). Transient.
 *   - `permanent`  — anything else (4xx, validation, auth). NOT safe to retry — retrying just wastes time.
 */
export type FailureKind = "rate_limit" | "server" | "network" | "timeout" | "permanent";

/** A classified failure: whether it is safe to retry, why, and any server-advised wait. */
export interface FailureClass {
  /** Whether the failure is transient and therefore safe to retry. `false` ⇒ give up immediately. */
  readonly transient: boolean;
  /** The category of failure. */
  readonly kind: FailureKind;
  /** The HTTP status the failure carried, if any. */
  readonly status: number | null;
  /**
   * The server-advised wait before retrying, in milliseconds, parsed from a `Retry-After` header — or
   * null when none was present. The backoff treats this as a floor (#638: respect Retry-After).
   */
  readonly retryAfterMs: number | null;
}
