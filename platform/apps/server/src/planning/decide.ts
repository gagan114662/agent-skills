/**
 * The Product Planning Loop dispatch decision (#115, ADR-0115). **Pure + unit-tested**: the service does
 * the side effects (draft the spec, launch the session, enqueue the approval, write the row); this
 * function makes the single choice — the #117 `decideDispatch` shape.
 *
 * **Route-first**, because queueing a human consumes no session slot and no spend: a pivot, an
 * over-budget effort, or a class no #95 rule auto-allows all **gate** (sensitive-by-default); only then
 * do the spend caps bite the **auto path** — kill switch / budget exhaustion **skip** (retry next tick).
 * Default-OFF means no #95 rule exists, so everything gates until an operator opts a class in.
 */

export type PlanningDispatchAction = "auto" | "gate" | "skip";

export interface PlanningDispatch {
  action: PlanningDispatchAction;
  reason: string;
}

export interface PlanningDispatchInput {
  /** A pivot changes product direction — always a human call (sensitive-by-default). */
  isPivot: boolean;
  /** Effort exceeds the auto-flow ceiling — an "over-budget effort" needs a human. */
  overEffortBudget: boolean;
  /** A #95 policy rule auto-approves small items of this class. */
  autoAllowed: boolean;
  /** The workspace has met/passed its #71 tenant-usage dollar ceiling — stop spending. */
  budgetExhausted: boolean;
  /** The #17 autonomy kill switch is engaged for this workspace. */
  killSwitchEngaged: boolean;
}

/**
 * Whether to auto-dispatch a build session, queue it for a human (#13), or skip this tick.
 *   1. pivot                → gate   (changes product direction — a human decides)
 *   2. over-budget effort   → gate   (effort above the auto-flow ceiling)
 *   3. not #95-auto-allowed → gate   (sensitive-by-default)
 *   — auto path only, in order: —
 *   4. kill switch engaged  → skip   (autonomy halted)
 *   5. budget exhausted     → skip   (no more spend on auto dispatches)
 *   6. otherwise            → auto
 */
export function decidePlanningDispatch(input: PlanningDispatchInput): PlanningDispatch {
  if (input.isPivot) return { action: "gate", reason: "pivot_requires_approval" };
  if (input.overEffortBudget) return { action: "gate", reason: "over_budget_effort" };
  if (!input.autoAllowed) return { action: "gate", reason: "policy_requires_approval" };
  if (input.killSwitchEngaged) return { action: "skip", reason: "kill_switch" };
  if (input.budgetExhausted) return { action: "skip", reason: "budget_exhausted" };
  return { action: "auto", reason: "auto_dispatch" };
}
