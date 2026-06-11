import type { IncidentSeverity, SloKind } from "./types.js";

/**
 * Pure SLO guards for the SRE Loop (#112), mirroring `watchdog/guards.ts`. No IO — `slo.ts` and
 * `decide.ts` compose these.
 */

/**
 * Kind-aware breach test. `availability` is a "higher is better" ratio (breach strictly below the
 * target); `latency_p95` and `queue_lag` are "lower is better" (breach strictly above the target).
 * The boundary (value === target) is never a breach — exactly at budget is still in-SLO.
 */
export function breaches(kind: SloKind, value: number, target: number): boolean {
  return kind === "availability" ? value < target : value > target;
}

/** True once the error budget is fully spent (no margin remains). */
export function budgetExhausted(budgetRemaining: number): boolean {
  return budgetRemaining <= 0;
}

/**
 * Severity from how much of the budget a breach has burned. Critical once the burn
 * (`1 − budgetRemaining`) reaches `criticalAtBudgetBurn` (default `1` — only a fully-exhausted budget
 * is critical); everything short of that is a warning.
 */
export function severityFor(budgetRemaining: number, criticalAtBudgetBurn = 1): IncidentSeverity {
  const burn = 1 - budgetRemaining;
  return burn >= criticalAtBudgetBurn ? "critical" : "warning";
}

/** True once the re-page cooldown has elapsed since the last notification (Infinity = never paged). */
export function cooldownElapsed(msSinceLastNotify: number, cooldownMs: number): boolean {
  return msSinceLastNotify >= cooldownMs;
}
