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

  it("KILLs a sub-threshold score from the second pass on (a bad idea that didn't improve still dies)", () => {
    expect(decideVenture(input({ score: 20, iteration: 2 })).verdict).toBe("KILL");
    expect(decideVenture(input({ score: 35, iteration: 2 })).verdict).toBe("KILL"); // boundary: <=
  });

  it("#441: a sub-threshold FIRST pass ITERATEs (improves) instead of dead-ending the workspace", () => {
    // The exact new-user dead-end: a founding idea scoring just below the kill line on pass 1 used to KILL
    // outright, stranding the whole workspace in no_work. Now it gets one real improvement pass.
    expect(decideVenture(input({ score: 32, iteration: 1, proposedAngles: ["novel"] })).verdict).toBe("ITERATE");
    expect(decideVenture(input({ score: 20, iteration: 1, proposedAngles: ["novel"] })).verdict).toBe("ITERATE");
    // With no angle left to pursue, a first-pass low score ESCALATEs to a human — never a silent death.
    expect(
      decideVenture(input({ score: 20, iteration: 1, proposedAngles: [], failedAngles: [] })).verdict,
    ).toBe("ESCALATE");
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

  it("FUND ignores loop state; KILL applies from the 2nd pass (first-pass killable improves first, #441)", () => {
    expect(decideVenture(input({ score: 90, iteration: 99, proposedAngles: [], failedAngles: ["x"] })).verdict).toBe(
      "FUND",
    );
    expect(decideVenture(input({ score: 10, iteration: 99, proposedAngles: [], failedAngles: ["x"] })).verdict).toBe(
      "KILL",
    );
    // The iteration-1 exception: a killable first pass with nowhere to iterate ESCALATEs, never KILLs silently.
    expect(decideVenture(input({ score: 10, iteration: 1, proposedAngles: [], failedAngles: ["x"] })).verdict).toBe(
      "ESCALATE",
    );
  });
});
