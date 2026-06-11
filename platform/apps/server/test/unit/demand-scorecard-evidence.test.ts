import { describe, it, expect } from "vitest";
import {
  demandScoreFromExternal,
  aggregateWithDemandOverlay,
  overlayDemandDimension,
  DEMAND_DIMENSION,
} from "../../src/demand/scorecard-evidence.js";
import { externalDemandEvidence, type DemandSignal, type ExternalDemandEvidence } from "../../src/demand/provenance.js";
import { aggregateScorecards, combineDimensions, RUBRIC_DIMENSIONS, type PersonaScorecard } from "../../src/venture/rubric.js";

function card(v: number): PersonaScorecard {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, v])) as PersonaScorecard;
}

function ev(signalClass: DemandSignal["signalClass"]): ExternalDemandEvidence {
  return externalDemandEvidence({
    signalClass,
    provenance: { kind: "externally_attributed", attribution: { source: "checkout", externalRef: `r-${signalClass}` } },
    amountCents: 1000,
    currency: "usd",
  })!;
}

describe("demandScoreFromExternal (external evidence → a 0–10 demand dimension)", () => {
  it("is 0 with no external evidence", () => {
    expect(demandScoreFromExternal([])).toBe(0);
  });
  it("a real paid signal is the maximal demand score", () => {
    expect(demandScoreFromExternal([ev("paid")])).toBe(10);
  });
  it("weaker classes score lower; the strongest present class dominates a mix", () => {
    expect(demandScoreFromExternal([ev("cta_click")])).toBeLessThan(demandScoreFromExternal([ev("checkout_started")]));
    expect(demandScoreFromExternal([ev("visit"), ev("cta_click"), ev("paid")])).toBe(10);
  });
});

describe("aggregateWithDemandOverlay (replace synthetic willingnessToPay with real demand)", () => {
  const advocate = card(8);
  const reviewer = card(8); // synthetic willingnessToPay would be 8 across the board
  const weight = 0.6;

  it("with no demand score, equals the plain aggregate (default-OFF, byte-for-byte)", () => {
    expect(aggregateWithDemandOverlay(advocate, reviewer, weight, null)).toBe(
      aggregateScorecards(advocate, reviewer, weight),
    );
  });

  it("a strong real-demand score raises the aggregate above the synthetic one", () => {
    const plain = aggregateScorecards(advocate, reviewer, weight);
    const overlaid = aggregateWithDemandOverlay(advocate, reviewer, weight, 10);
    expect(overlaid).toBeGreaterThan(plain);
  });

  it("a weak real-demand score (no one paid) lowers the aggregate below the synthetic one", () => {
    const plain = aggregateScorecards(advocate, reviewer, weight);
    const overlaid = aggregateWithDemandOverlay(advocate, reviewer, weight, 1);
    expect(overlaid).toBeLessThan(plain);
  });

  it("overlayDemandDimension replaces only the demand dimension", () => {
    const combined = combineDimensions(advocate, reviewer, weight);
    const out = overlayDemandDimension(combined, 2);
    expect(out[DEMAND_DIMENSION]).toBe(2);
    for (const d of RUBRIC_DIMENSIONS) {
      if (d !== DEMAND_DIMENSION) expect(out[d]).toBe(combined[d]);
    }
  });
});
