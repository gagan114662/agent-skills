import type { WorkflowRunDecision, WorkflowRunDecisionInput } from "./types.js";

/**
 * The single workflow-run decision (#152, ADR-0152 §3). **Pure + unit-tested**: the engine resolves
 * every async fact (due? conditions met? runs in the window? kill switch?) BEFORE calling, then applies
 * the side effects (execute actions, record). The generalization of #147 `decideAutomationRun` — same
 * ladder, plus a `conditions` rung between "due" and "rate".
 *
 * Ordered ladder — cheapest, no-spend skips first:
 *   1. caps disabled       → skip  (the workspace hasn't opted into workflows)
 *   2. workflow disabled   → skip  (the owner paused this one)
 *   3. kill switch engaged → skip  (#17 halt)
 *   4. not due             → skip  (the scheduler cursor is in the future)
 *   5. conditions unmet    → skip  (a predicate over catalog/metrics did not hold)
 *   6. over the rate window→ skip  (per-tenant firings/window cap — the "caps on firings per day")
 *   7. otherwise           → run
 */
export function decideWorkflowRun(input: WorkflowRunDecisionInput): WorkflowRunDecision {
  if (!input.capsEnabled) return { action: "skip", reason: "workflows_disabled" };
  if (!input.workflowEnabled) return { action: "skip", reason: "workflow_disabled" };
  if (input.killSwitch) return { action: "skip", reason: "kill_switch" };
  if (!input.due) return { action: "skip", reason: "not_due" };
  if (!input.conditionsMet) return { action: "skip", reason: "conditions_unmet" };
  if (input.runsInWindow >= input.maxRunsPerWindow) return { action: "skip", reason: "rate_limited" };
  return { action: "run", reason: "conditions_met" };
}
