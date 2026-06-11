import { describe, it, expect } from "vitest";
import { proposePriceLadder } from "../../src/constitution/pricing-ladder.js";
import { CONSTITUTION_DEFAULTS } from "../../src/constitution/caps.js";

const caps = CONSTITUTION_DEFAULTS.pricing; // 10 / 5 / 20

describe("proposePriceLadder (Article VIII — the 10/5/20 pricing ladder)", () => {
  it("proposes a coarse +10% step when deal-loss is comfortably low", () => {
    const p = proposePriceLadder({ currentPriceCents: 10000, dealLossPct: 2, caps });
    expect(p.action).toBe("raise_coarse");
    expect(p.stepPct).toBe(10);
    expect(p.proposedPriceCents).toBe(11000);
    expect(p.flagged).toBe(false);
  });

  it("proposes a fine +5% step as deal-loss approaches the ceiling", () => {
    const p = proposePriceLadder({ currentPriceCents: 10000, dealLossPct: 15, caps });
    expect(p.action).toBe("raise_fine");
    expect(p.stepPct).toBe(5);
    expect(p.proposedPriceCents).toBe(10500);
    expect(p.flagged).toBe(false);
  });

  it("holds and FLAGS when deal-loss reaches/exceeds the 20% ceiling — never raises", () => {
    const p = proposePriceLadder({ currentPriceCents: 10000, dealLossPct: 22, caps });
    expect(p.action).toBe("hold");
    expect(p.stepPct).toBe(0);
    expect(p.proposedPriceCents).toBe(10000); // unchanged
    expect(p.flagged).toBe(true);
  });

  it("holds + flags exactly at the ceiling boundary (20%)", () => {
    const p = proposePriceLadder({ currentPriceCents: 10000, dealLossPct: 20, caps });
    expect(p.action).toBe("hold");
    expect(p.flagged).toBe(true);
  });

  it("is always a proposal for human approval — never an autonomous change", () => {
    const p = proposePriceLadder({ currentPriceCents: 10000, dealLossPct: 2, caps });
    expect(p.requiresApproval).toBe(true);
  });

  it("rounds the proposed price to whole cents", () => {
    const p = proposePriceLadder({ currentPriceCents: 999, dealLossPct: 0, caps });
    expect(Number.isInteger(p.proposedPriceCents)).toBe(true);
    expect(p.proposedPriceCents).toBe(1099); // 999 * 1.10 = 1098.9 → 1099
  });

  it("clamps an out-of-range deal-loss into [0,100]", () => {
    expect(proposePriceLadder({ currentPriceCents: 100, dealLossPct: -5, caps }).action).toBe(
      "raise_coarse",
    );
    expect(proposePriceLadder({ currentPriceCents: 100, dealLossPct: 250, caps }).flagged).toBe(true);
  });
});
