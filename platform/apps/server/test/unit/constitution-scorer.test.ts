import { describe, it, expect } from "vitest";
import { scoreDecision } from "../../src/constitution/scorer.js";
import { CONSTITUTION_DEFAULTS } from "../../src/constitution/caps.js";
import type { ConstitutionDecisionContext } from "../../src/constitution/types.js";

const caps = { ...CONSTITUTION_DEFAULTS, enabled: true };

function ctx(over: Partial<ConstitutionDecisionContext>): ConstitutionDecisionContext {
  return {
    stage: "FUND",
    segment: null,
    unaffiliatedPayingIntentSignals: 0,
    externalDemandPresent: true,
    paidSignalPresent: true,
    ...over,
  };
}

function codes(c: ConstitutionDecisionContext) {
  return scoreDecision(c, caps).violations.map((v) => v.code);
}

describe("scoreDecision (Article checks on SOURCE/FUND/KILL)", () => {
  it("flags a B2B FUND below the love threshold (Article I)", () => {
    const out = codes(ctx({ segment: "b2b", unaffiliatedPayingIntentSignals: 1 }));
    expect(out).toContain("love_paradigm_unmet");
  });

  it("does NOT flag love when the B2B venture meets the threshold", () => {
    const out = codes(ctx({ segment: "b2b", unaffiliatedPayingIntentSignals: 10 }));
    expect(out).not.toContain("love_paradigm_unmet");
  });

  it("flags a FUND made with no externally-attributed demand (Article V)", () => {
    const out = codes(ctx({ externalDemandPresent: false }));
    expect(out).toContain("funded_on_synthetic_demand");
  });

  it("flags a FUND with no realized payment (Article VIII)", () => {
    const out = codes(ctx({ paidSignalPresent: false }));
    expect(out).toContain("funded_without_realized_payment");
  });

  it("returns NO violations for a FUND backed by real, paid, external evidence", () => {
    const out = codes(
      ctx({ segment: "b2b", unaffiliatedPayingIntentSignals: 12, externalDemandPresent: true, paidSignalPresent: true }),
    );
    expect(out).toEqual([]);
  });

  it("treats a KILL as constitution-compliant (Article II) — no violations", () => {
    const out = codes(ctx({ stage: "KILL", externalDemandPresent: false, paidSignalPresent: false }));
    expect(out).toEqual([]);
  });

  it("emits an early-warning at SOURCE for a B2B idea with no demand evidence yet", () => {
    const out = codes(
      ctx({ stage: "SOURCE", segment: "b2b", externalDemandPresent: false }),
    );
    expect(out).toContain("b2b_sourced_without_demand");
    // SOURCE never emits the hard FUND-stage violations.
    expect(out).not.toContain("funded_on_synthetic_demand");
  });

  it("is inert when the constitution is disabled", () => {
    const disabled = { ...caps, enabled: false };
    const out = scoreDecision(ctx({ externalDemandPresent: false, paidSignalPresent: false }), disabled);
    expect(out.violations).toEqual([]);
  });

  it("every violation carries the deciding stage and a non-empty message", () => {
    const violations = scoreDecision(
      ctx({ segment: "b2b", unaffiliatedPayingIntentSignals: 0, externalDemandPresent: false, paidSignalPresent: false }),
      caps,
    ).violations;
    expect(violations.length).toBeGreaterThanOrEqual(3);
    for (const v of violations) {
      expect(v.stage).toBe("FUND");
      expect(v.message.length).toBeGreaterThan(0);
    }
  });
});
