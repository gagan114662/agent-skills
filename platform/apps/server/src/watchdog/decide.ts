import type { WatchdogDecision, WatchdogThresholds } from "./types.js";
import { backoffElapsed, isStale, revivalLimitReached } from "./guards.js";

/**
 * The watchdog decision (#105, ADR-0105 §3). **Pure + unit-tested**: given a stalled session's
 * no-progress age, its lineage's revival history, the failure class's retryability, and the guard
 * signals, decide the **single** action the engine should apply this tick. The engine does the side
 * effects (finalize the dead row, launch the replacement, write the revival record, enqueue the
 * escalation); this function does the choice — exactly the #17 `decideWorkflowAction` / #96
 * `decideVenture` split.
 *
 * Priority is deliberate — hard stops first, then "is there even anything to do", then the bounded
 * policy:
 *   1. kill switch                         → noop  (authoritative; halts immediately)
 *   2. not yet stale                       → noop  (nothing to revive)
 *   3. non-retryable failure class         → escalate (never infinite-retry a broken session)
 *   4. revival limit reached this window   → escalate (repeated death → a human)
 *   5. dollar budget exhausted             → escalate (no more spend on revivals)
 *   6. inside the backoff window           → wait   (stale, but don't hammer)
 *   7. otherwise                           → revive
 */
export interface RevivalDecisionInput {
  /** ms since the session last showed progress (`now − last heartbeat / started / created`). */
  staleForMs: number;
  /** Revivals already attempted for this lineage in the current rolling window. */
  revivalsInWindow: number;
  /** ms since the lineage's last revival (`Infinity` if never revived). */
  msSinceLastRevival: number;
  /** Whether the failure class is worth reviving (from {@link classifyFailure}). */
  retryable: boolean;
  /** Workspace kill switch (#17) — authoritative; halts immediately. */
  killSwitch: boolean;
  /** The workspace has met/passed its #71 tenant-usage dollar ceiling — stop spending. */
  budgetExhausted: boolean;
  thresholds: WatchdogThresholds;
}

const noop = (reason: string): WatchdogDecision => ({ action: "noop", reason });
const escalate = (reason: string): WatchdogDecision => ({ action: "escalate", reason });

export function decideRevival(input: RevivalDecisionInput): WatchdogDecision {
  const { staleForMs, revivalsInWindow, msSinceLastRevival, retryable, killSwitch, budgetExhausted } =
    input;
  const { staleCutoffMs, maxRevivalsPerWindow, backoffMs } = input.thresholds;

  if (killSwitch) return noop("kill_switch");
  if (!isStale(staleForMs, staleCutoffMs)) return noop("not_stale");

  // It IS stale → it needs intervention. Decide revive vs escalate vs wait.
  if (!retryable) return escalate("non_retryable_failure");
  if (revivalLimitReached(revivalsInWindow, maxRevivalsPerWindow)) return escalate("revival_limit");
  if (budgetExhausted) return escalate("budget_exhausted");
  if (!backoffElapsed(msSinceLastRevival, backoffMs)) return { action: "wait", reason: "backoff" };

  return { action: "revive", reason: "stale_session" };
}
