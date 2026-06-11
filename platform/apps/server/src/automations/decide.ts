import type { AutomationRunDecision, AutomationRunDecisionInput } from "./types.js";

/**
 * The single automations decision (#147, ADR-0147 §1). **Pure + unit-tested**: the engine resolves
 * every async fact (due? runs in the window? kill switch?) BEFORE calling, then applies the side
 * effects (render, launch, record). Mirrors the #117 `decideDispatch` / #105 `decideRevival` split.
 *
 * Ordered ladder — the cheapest, no-spend skips first, so a disabled or not-due automation never
 * touches the launch path:
 *   1. caps disabled        → skip  (the workspace hasn't opted in)
 *   2. automation disabled  → skip  (the owner paused this one)
 *   3. kill switch engaged  → skip  (#17 halt)
 *   4. not due              → skip  (the scheduler cursor is in the future)
 *   5. over the rate window → skip  (per-tenant runs/window cap)
 *   6. otherwise            → run
 */
export function decideAutomationRun(input: AutomationRunDecisionInput): AutomationRunDecision {
  if (!input.capsEnabled) return { action: "skip", reason: "automations_disabled" };
  if (!input.automationEnabled) return { action: "skip", reason: "automation_disabled" };
  if (input.killSwitch) return { action: "skip", reason: "kill_switch" };
  if (!input.due) return { action: "skip", reason: "not_due" };
  if (input.runsInWindow >= input.maxRunsPerWindow) return { action: "skip", reason: "rate_limited" };
  return { action: "run", reason: "due" };
}
