/**
 * Autonomy safety guards (#17, ADR-0017 §8). Pure predicates so the bounds on autonomous action
 * are validated the same way everywhere and unit-tested without a database — the matching DB state
 * lives on `agent_autonomy` (rate/cost) and `agent_workflows.action_count` (loop).
 */

/** Default loop-guard ceiling: a single workflow may take at most this many autonomous actions. */
export const DEFAULT_LOOP_GUARD_MAX = 50;

/** Cost guard: the agent has spent its action budget (the spend proxy) — stop acting. */
export function budgetExhausted(actionsUsed: number, actionBudget: number): boolean {
  return actionsUsed >= actionBudget;
}

/** Rate guard: the agent has already taken its allotted actions for this tick. */
export function tickLimitReached(actionsThisTick: number, maxActionsPerTick: number): boolean {
  return actionsThisTick >= maxActionsPerTick;
}

/** Loop guard: a workflow has churned past the ceiling without reaching a gate — stop it. */
export function loopGuardTripped(actionCount: number, max: number = DEFAULT_LOOP_GUARD_MAX): boolean {
  return actionCount >= max;
}
