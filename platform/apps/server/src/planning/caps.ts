import type { PlanningConfig } from "../config/schema.js";

/**
 * Resolve the planning-loop policy from the layered config (#58), applying hard defaults — mirrors
 * `flywheel/caps.ts` / `growth/caps.ts`. The planning loop is **default OFF** (`enabled: false`): a
 * deployment that sets no `planning` section drafts no specs and proposes no sessions.
 *
 * Recording backlog items + reading the ranked backlog are always available (harmless, tenant-scoped) —
 * `enabled` gates only the proactive planning tick, the same way #119 keeps evidence recording on while
 * gating the auto behaviour.
 */
export interface PlanningCaps {
  /** The planning-tick flag. OFF by default. */
  enabled: boolean;
  /** Effort (points) above which an item is an "over-budget effort" → #13 gate (never auto). */
  autoEffortCeiling: number;
  /** Estimated cost (cents) charged to #71 tenant usage per auto-dispatch — the dollar-ceiling input. */
  dispatchCostCents: number;
  /** Hard cap on auto-dispatches proposed in a single tick (top-ranked first). */
  maxDispatchesPerTick: number;
}

export const PLANNING_DEFAULTS: PlanningCaps = {
  enabled: false,
  autoEffortCeiling: 3, // anything bigger than a small (≤3-point) item needs a human
  dispatchCostCents: 0, // 0 ⇒ a dispatch costs nothing against the budget (operator sets a real rate)
  maxDispatchesPerTick: 1, // one build proposal per tick by default (the top item)
};

export function resolvePlanningCaps(cfg: PlanningConfig | undefined): PlanningCaps {
  return {
    enabled: cfg?.enabled ?? PLANNING_DEFAULTS.enabled,
    autoEffortCeiling: cfg?.autoEffortCeiling ?? PLANNING_DEFAULTS.autoEffortCeiling,
    dispatchCostCents: cfg?.dispatchCostCents ?? PLANNING_DEFAULTS.dispatchCostCents,
    maxDispatchesPerTick: cfg?.maxDispatchesPerTick ?? PLANNING_DEFAULTS.maxDispatchesPerTick,
  };
}
