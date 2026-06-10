/**
 * Shared types for the Fleet Watchdog (#105, ADR-0105). The pure `decide`/`guards`/`taxonomy` modules
 * and the IO `engine` agree on these — mirroring the #17 autonomy and #96 venture `types.ts` split.
 */

/** The single action the watchdog applies to a stalled session this tick. */
export type WatchdogAction = "revive" | "escalate" | "wait" | "noop";

export interface WatchdogDecision {
  action: WatchdogAction;
  /** Why — surfaced in logs/metrics and asserted in tests. */
  reason: string;
}

/** The bounded-restart knobs the pure decision consumes (projected from {@link WatchdogCaps}). */
export interface WatchdogThresholds {
  /** No-progress age (ms) at/above which a non-terminal session is considered stalled. */
  staleCutoffMs: number;
  /** Hard cap on revivals within one rolling window before escalation (0 = never revive). */
  maxRevivalsPerWindow: number;
  /** Length (ms) of the rolling window the revival count is measured over. */
  windowMs: number;
  /** Minimum time (ms) between revivals of one lineage (the backoff). */
  backoffMs: number;
}
