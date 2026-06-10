import { describe, it, expect } from "vitest";
import { decideVenture, type VentureDecisionInput } from "../../src/venture/decide.js";
import type { VentureThresholds } from "../../src/venture/types.js";

const thresholds: VentureThresholds = { fund: 70, kill: 35, escalateBand: 10, maxIterations: 3 };

/** A mid-band, first-iteration, has-a-novel-angle input — the ITERATE baseline; override per case. */
function input(over: Partial<VentureDecisionInput> = {}): VentureDecisionInput {
  return {
    score: 50,
    iteration: 1,
    proposedAngles: ["problemSeverity"],
    failedAngles: [],
    budgetExhausted: false,
    thresholds,
    ...over,
  };
}

describe("decideVenture (the pure YC-fundability gate)", () => {
  it("FUNDs when the score meets the fund threshold", () => {
    expect(decideVenture(input({ score: 85 })).verdict).toBe("FUND");
    expect(decideVenture(input({ score: 70 })).verdict).toBe("FUND"); // boundary: >=
  });

  it("KILLs when the score is at/below the kill threshold", () => {
    expect(decideVenture(input({ score: 20 })).verdict).toBe("KILL");
    expect(decideVenture(input({ score: 35 })).verdict).toBe("KILL"); // boundary: <=
  });

  it("ESCALATEs a borderline near-miss just below the fund line", () => {
    expect(decideVenture(input({ score: 65 })).verdict).toBe("ESCALATE");
    expect(decideVenture(input({ score: 60 })).verdict).toBe("ESCALATE"); // boundary: fund-band
    // 69.999 is still in the escalate band, never FUND.
    expect(decideVenture(input({ score: 69 })).verdict).toBe("ESCALATE");
  });

  it("ITERATEs in the mid-band with a novel angle and iterations remaining", () => {
    const d = decideVenture(input({ score: 50, iteration: 1, proposedAngles: ["novel"], failedAngles: [] }));
    expect(d.verdict).toBe("ITERATE");
    expect(d.reasoning).toBeTruthy();
  });

  it("ESCALATEs on the max-iteration exit (budget exhausted, never loops forever)", () => {
    // mid-band score that would ITERATE, but the iteration budget is spent → human exit.
    expect(decideVenture(input({ score: 50, iteration: 3, proposedAngles: ["novel"] })).verdict).toBe(
      "ESCALATE",
    );
    expect(decideVenture(input({ score: 50, iteration: 4, proposedAngles: ["novel"] })).verdict).toBe(
      "ESCALATE",
    );
  });

  it("ESCALATEs on the no-repeated-failed-angle check (no progress possible)", () => {
    // The only angle left was already tried and failed → escalate, don't re-run it.
    expect(
      decideVenture(input({ score: 50, iteration: 1, proposedAngles: ["a"], failedAngles: ["a"] })).verdict,
    ).toBe("ESCALATE");
    // No angle at all to pursue → also escalate (can't iterate on nothing).
    expect(
      decideVenture(input({ score: 50, iteration: 1, proposedAngles: [], failedAngles: [] })).verdict,
    ).toBe("ESCALATE");
  });

  it("ESCALATEs on the dollar-budget exhaustion exit (mid-band, no more spend)", () => {
    expect(
      decideVenture(input({ score: 50, budgetExhausted: true, proposedAngles: ["novel"] })).verdict,
    ).toBe("ESCALATE");
  });

  it("a FUND-worthy score still FUNDs even when the budget is exhausted (work is done)", () => {
    expect(decideVenture(input({ score: 80, budgetExhausted: true })).verdict).toBe("FUND");
  });

  it("ITERATEs when at least one proposed angle is novel even if others repeat", () => {
    expect(
      decideVenture(input({ score: 50, proposedAngles: ["a", "fresh"], failedAngles: ["a"] })).verdict,
    ).toBe("ITERATE");
  });

  it("orders hard verdicts over loop state: FUND/KILL ignore iteration + angles", () => {
    expect(decideVenture(input({ score: 90, iteration: 99, proposedAngles: [], failedAngles: ["x"] })).verdict).toBe(
      "FUND",
    );
    expect(decideVenture(input({ score: 10, iteration: 99, proposedAngles: [], failedAngles: ["x"] })).verdict).toBe(
      "KILL",
    );
  });
});
