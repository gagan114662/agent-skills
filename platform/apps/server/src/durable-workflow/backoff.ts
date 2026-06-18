import type { BackoffPolicy } from "./types.js";

/**
 * Pure exponential backoff (#338). `attempt` is 0-based — the number of attempts ALREADY run — so the
 * wait before attempt N+1 is `min(capMs, baseMs * factor^attempt)`. No clock, no jitter, no randomness:
 * the core stays deterministic so the retry-with-backoff schedule is exactly unit-testable (premortem
 * #200 §3 — verifiable, never "it should back off about right"). Defensive: a non-positive base/factor
 * collapses to `baseMs` so a misconfig can never produce a negative or NaN delay.
 */
export function nextBackoffMs(attempt: number, policy: BackoffPolicy): number {
  const base = policy.baseMs > 0 ? policy.baseMs : 0;
  const factor = policy.factor >= 1 ? policy.factor : 1;
  const cap = policy.capMs > 0 ? policy.capMs : base;
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const raw = base * Math.pow(factor, n);
  if (!Number.isFinite(raw)) return cap;
  return Math.min(cap, raw);
}
