import type { CostTier } from "../agent-registry/contract.js";

/**
 * Per-agent "pricing" for the Garden surface (#284, ADR-0284, premortem #200 FM#2).
 *
 * We deliberately surface NO dollar figure and NO usage metric: a fabricated "$X/mo" or "saved you N hours"
 * would be a self-reported number with no external receipt (FM#2 — self-reported metrics are fiction). The
 * price signal is the contract's developer-authored `costTier` (the same one ADR-0282 declares), rendered as
 * a coarse compute-weight label. Real per-agent dollar pricing is an ADR-0284 slice-4 follow-up that waits on
 * measured per-persona usage attribution + a Stripe-grounded plan mapping. Pure + total.
 */

/** A coarse, honest pricing label for a cost tier — a relative compute weight, never a fabricated number. */
export function gardenPriceLabel(costTier: CostTier): string {
  switch (costTier) {
    case "low":
      return "Light compute";
    case "medium":
      return "Standard compute";
    case "high":
      return "Heavy compute";
    default: {
      // Exhaustiveness guard: a new CostTier must add a label here (compile-time catch).
      const _exhaustive: never = costTier;
      return _exhaustive;
    }
  }
}
