import type { PricingLadderCaps } from "./caps.js";

/**
 * Article VIII — the 10/5/20 pricing ladder (#146, ADR-0146). **Pure + unit-tested.** YC pricing
 * wisdom: most founders charge too little; raise prices until deal-loss reveals the ceiling. This
 * module *proposes* a disciplined increment and *flags* when deal-loss says stop — but it has no IO and
 * no path to a price change. The proposal becomes a #13 approval a human acts on; pricing is **never
 * autonomous**.
 *
 * The bands (defaults 10/5/20):
 *   - deal-loss < (ceiling − coarseStep)  → coarse step (+10%): comfortably below the ceiling, push.
 *   - deal-loss in [that, ceiling)        → fine step  (+5%): approaching the ceiling, ease up.
 *   - deal-loss ≥ ceiling (20%)           → hold + FLAG: the ceiling is found; raising further loses
 *                                            too many deals — a human reviews.
 */
export type PricingAction = "raise_coarse" | "raise_fine" | "hold";

export interface PricingLadderInput {
  currentPriceCents: number;
  /** The share of deals lost at the current price (0–100). Clamped into range. */
  dealLossPct: number;
  caps: PricingLadderCaps;
}

export interface PricingProposal {
  action: PricingAction;
  currentPriceCents: number;
  /** The proposed new price (unchanged on `hold`). */
  proposedPriceCents: number;
  /** The increment applied (%), 0 on `hold`. */
  stepPct: number;
  /** The (clamped) deal-loss the proposal was computed against. */
  dealLossPct: number;
  /** True when deal-loss reached/exceeded the ceiling — the flag the owner must review. */
  flagged: boolean;
  reason: string;
  /** Structural reminder: a proposal is ALWAYS human-gated, never an autonomous change. */
  requiresApproval: true;
}

function clampPct(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function raise(currentPriceCents: number, stepPct: number): number {
  return Math.round(currentPriceCents * (1 + stepPct / 100));
}

export function proposePriceLadder(input: PricingLadderInput): PricingProposal {
  const { currentPriceCents, caps } = input;
  const dealLossPct = clampPct(input.dealLossPct);
  const { coarseStepPct, fineStepPct, dealLossCeilingPct } = caps;

  if (dealLossPct >= dealLossCeilingPct) {
    return {
      action: "hold",
      currentPriceCents,
      proposedPriceCents: currentPriceCents,
      stepPct: 0,
      dealLossPct,
      flagged: true,
      reason: `deal-loss ${dealLossPct}% ≥ ${dealLossCeilingPct}% ceiling — hold and review (the price ceiling is found)`,
      requiresApproval: true,
    };
  }

  const approaching = dealLossCeilingPct - coarseStepPct;
  if (dealLossPct >= approaching) {
    return {
      action: "raise_fine",
      currentPriceCents,
      proposedPriceCents: raise(currentPriceCents, fineStepPct),
      stepPct: fineStepPct,
      dealLossPct,
      flagged: false,
      reason: `deal-loss ${dealLossPct}% approaching the ${dealLossCeilingPct}% ceiling — propose a fine +${fineStepPct}% step`,
      requiresApproval: true,
    };
  }

  return {
    action: "raise_coarse",
    currentPriceCents,
    proposedPriceCents: raise(currentPriceCents, coarseStepPct),
    stepPct: coarseStepPct,
    dealLossPct,
    flagged: false,
    reason: `deal-loss ${dealLossPct}% comfortably below the ${dealLossCeilingPct}% ceiling — propose a coarse +${coarseStepPct}% step`,
    requiresApproval: true,
  };
}
