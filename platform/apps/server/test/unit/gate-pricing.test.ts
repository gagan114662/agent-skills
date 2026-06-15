import { describe, it, expect } from "vitest";
import {
  decideGatePricing,
  summarizeWindow,
  editDistance,
  type GatePricingInput,
  type PricingThresholds,
  type Outcome,
} from "../../src/gate-pricing/pricing.js";
import {
  INVARIANT_ACTION_TYPES,
  isInvariantAction,
  relaxableAction,
  SECRETS_ACCESS_ACTION,
  __assertInvariantsCannotRelax,
} from "../../src/gate-pricing/invariants.js";
import { DEFAULT_SENSITIVE_ACTIONS } from "../../src/approvals/policy.js";

const thresholds: PricingThresholds = {
  minSamples: 100,
  relaxBelowRate: 0.05,
  retightenAboveRate: 0.15,
};

/** A reversible, strict-boundary, full-window, zero-error baseline — the RELAX baseline. */
function input(over: Partial<GatePricingInput> = {}): GatePricingInput {
  return {
    actionType: "chat.post_message",
    window: summarizeWindow(Array<Outcome>(100).fill("approved")),
    currentlyRelaxed: false,
    thresholds,
    ...over,
  };
}

/** Build a window of `total` decisions with `bad` of them being corrections (rejected/edited). */
function windowWith(total: number, bad: number): GatePricingInput["window"] {
  const outcomes: Outcome[] = [
    ...Array<Outcome>(bad).fill("edited"),
    ...Array<Outcome>(Math.max(0, total - bad)).fill("approved"),
  ];
  return summarizeWindow(outcomes);
}

describe("summarizeWindow (the trailing-window roll-up)", () => {
  it("counts each outcome and computes error rate = (rejected + edited) / total", () => {
    const s = summarizeWindow(["approved", "approved", "rejected", "edited"]);
    expect(s).toEqual({ total: 4, approved: 2, rejected: 1, edited: 1, errorRate: 0.5 });
  });

  it("is a zero error rate (not NaN) for an empty window", () => {
    expect(summarizeWindow([])).toEqual({
      total: 0,
      approved: 0,
      rejected: 0,
      edited: 0,
      errorRate: 0,
    });
  });
});

describe("editDistance (pure Levenshtein for drafted-content correction)", () => {
  it("is zero for identical strings", () => {
    expect(editDistance("ship it", "ship it")).toBe(0);
  });
  it("is the length when one side is empty", () => {
    expect(editDistance("", "abcd")).toBe(4);
    expect(editDistance("abcd", "")).toBe(4);
  });
  it("counts single-edit substitutions, insertions, and deletions", () => {
    expect(editDistance("kitten", "sitting")).toBe(3); // classic
    expect(editDistance("draft", "drafts")).toBe(1); // insertion
    expect(editDistance("draft", "raft")).toBe(1); // deletion
  });
});

describe("decideGatePricing (the pure evidence pricer)", () => {
  it("RELAXes a strict reversible class with a low error rate over a full window", () => {
    const d = decideGatePricing(input());
    expect(d.recommendation).toBe("RELAX");
    if (d.recommendation === "RELAX") {
      // the recommendation carries the (proven non-invariant) action
      expect(d.action).toBe("chat.post_message");
      expect(d.errorRate).toBe(0);
      expect(d.windowSize).toBe(100);
    }
  });

  it("RELAXes right below the relax rail (boundary: strictly <)", () => {
    // 4 / 100 = 0.04 < 0.05 → relax
    expect(decideGatePricing(input({ window: windowWith(100, 4) })).recommendation).toBe("RELAX");
    // 5 / 100 = 0.05 is NOT strictly below the rail → hold (dead band)
    expect(decideGatePricing(input({ window: windowWith(100, 5) })).recommendation).toBe("HOLD");
  });

  it("HOLDs a strict class without enough evidence even at zero error", () => {
    const d = decideGatePricing(input({ window: windowWith(99, 0) }));
    expect(d.recommendation).toBe("HOLD");
    expect(d.reason).toMatch(/insufficient evidence/i);
  });

  it("RETIGHTENs a relaxed class once the error rate climbs above the upper rail", () => {
    // 16 / 100 = 0.16 > 0.15 → retighten
    const d = decideGatePricing(input({ currentlyRelaxed: true, window: windowWith(100, 16) }));
    expect(d.recommendation).toBe("RETIGHTEN");
    expect(d.errorRate).toBeCloseTo(0.16);
  });

  it("does NOT re-tighten a relaxed class still inside tolerance (boundary: not strictly >)", () => {
    // 15 / 100 = 0.15 is not strictly above the rail → hold
    expect(
      decideGatePricing(input({ currentlyRelaxed: true, window: windowWith(100, 15) })).recommendation,
    ).toBe("HOLD");
  });

  it("cannot flap: a mid-band error rate HOLDs from BOTH sides (hysteresis)", () => {
    // 0.10 is between the relax rail (0.05) and the re-tighten rail (0.15): neither side moves.
    const mid = windowWith(100, 10);
    expect(decideGatePricing(input({ currentlyRelaxed: false, window: mid })).recommendation).toBe(
      "HOLD",
    );
    expect(decideGatePricing(input({ currentlyRelaxed: true, window: mid })).recommendation).toBe(
      "HOLD",
    );
  });
});

describe("invariant action classes (structural — can NEVER auto-relax)", () => {
  it("includes the whole #13 hard list (money actions, #243) plus secrets access", () => {
    for (const a of DEFAULT_SENSITIVE_ACTIONS) {
      expect(isInvariantAction(a)).toBe(true);
    }
    expect(isInvariantAction(SECRETS_ACCESS_ACTION)).toBe(true);
    expect(INVARIANT_ACTION_TYPES).toContain("billing.payout");
    expect(INVARIANT_ACTION_TYPES).toContain("secrets.access");
    // Under #243 the hard list is money-only: an autonomous non-money action (a send) is NOT invariant.
    expect(INVARIANT_ACTION_TYPES).not.toContain("external.send");
    expect(isInvariantAction("external.send")).toBe(false);
    // a reversible class is not invariant
    expect(isInvariantAction("chat.post_message")).toBe(false);
  });

  it("relaxableAction returns null for every invariant and the action for a reversible class", () => {
    for (const a of INVARIANT_ACTION_TYPES) {
      expect(relaxableAction(a)).toBeNull();
    }
    expect(relaxableAction("chat.post_message")).toBe("chat.post_message");
  });

  it("NEVER RELAXes an invariant class even with a perfect window — it HOLDs strict", () => {
    for (const a of INVARIANT_ACTION_TYPES) {
      const d = decideGatePricing(input({ actionType: a, window: windowWith(1000, 0) }));
      expect(d.recommendation).not.toBe("RELAX");
      expect(d.recommendation).toBe("HOLD");
    }
  });

  it("RE-TIGHTENs an invariant class that is somehow found relaxed (defense in depth)", () => {
    const d = decideGatePricing(
      input({ actionType: "billing.payout", currentlyRelaxed: true, window: windowWith(1000, 0) }),
    );
    expect(d.recommendation).toBe("RETIGHTEN");
    expect(d.reason).toMatch(/invariant/i);
  });

  it("structurally forbids a RELAX recommendation for an invariant class", () => {
    // The runtime half of the guarantee: the only constructor of the branded RelaxableActionType
    // refuses every invariant, so no RELAX (which must carry one) can be built for one.
    for (const a of INVARIANT_ACTION_TYPES) expect(relaxableAction(a)).toBeNull();
    // The COMPILE-TIME half lives in `src/gate-pricing/invariants.ts`
    // (`__assertInvariantsCannotRelax`): a `@ts-expect-error` there asserts a raw invariant string is
    // not assignable to the brand, so weakening it breaks `pnpm typecheck`. Calling it here keeps the
    // proof referenced (it has no runtime effect).
    expect(__assertInvariantsCannotRelax()).toBeUndefined();
  });
});
