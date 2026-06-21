import { nextBackoffMs } from "../durable-workflow/backoff.js";
import type { BackoffPolicy } from "../durable-workflow/types.js";
import type { SchedulerRunStatus } from "./types.js";

/**
 * The pure cursor-advance for a completed tick (#559). Given a run's outcome it returns the next cursor and
 * the new failure counter — no clock, no IO, so the schedule is exactly unit-testable (premortem #200 §3:
 * verifiable, never "it should back off about right").
 *
 *  - ok    → next run is exactly one interval out; failures reset to 0 (steady cadence resumes).
 *  - error → failures++ and the next run is a bounded backoff `min(cap, base·factor^(failures-1))` out.
 *    `capMs` bounds the delay, so a permanently-failing tick retries forever on a CAPPED cadence — it can
 *    never hang and never silently stops the loop (the no-hang guarantee at the cadence axis). `maxAttempts`
 *    is deliberately NOT consulted: a recurring engine tick must keep trying, unlike a one-shot durable job.
 */
export interface NextRunInput {
  status: SchedulerRunStatus;
  nowMs: number;
  intervalMs: number;
  /** Consecutive failures BEFORE this run's outcome is folded in. */
  priorConsecutiveFailures: number;
  policy: BackoffPolicy;
}

export interface NextRunDecision {
  nextRunAtMs: number;
  consecutiveFailures: number;
}

export function decideNextRun(input: NextRunInput): NextRunDecision {
  const interval = Number.isFinite(input.intervalMs) && input.intervalMs > 0 ? input.intervalMs : 0;
  if (input.status === "ok") {
    return { nextRunAtMs: input.nowMs + interval, consecutiveFailures: 0 };
  }
  const consecutiveFailures = Math.max(0, input.priorConsecutiveFailures) + 1;
  // attempt index is 0-based (failures already run minus this one) → first failure waits `baseMs`.
  const delay = nextBackoffMs(consecutiveFailures - 1, input.policy);
  return { nextRunAtMs: input.nowMs + delay, consecutiveFailures };
}

/**
 * Whether a job is claimable right now: due (`nextRunAt <= now`) and either unleased or its lease expired.
 * The DB store enforces the same predicate inside an atomic UPDATE; this mirror powers the in-memory store
 * and is exported so the contract is asserted in one place.
 */
export function isClaimable(
  state: { nextRunAtMs: number; lockedUntilMs: number | null },
  nowMs: number,
): boolean {
  if (state.nextRunAtMs > nowMs) return false;
  if (state.lockedUntilMs !== null && state.lockedUntilMs > nowMs) return false;
  return true;
}
