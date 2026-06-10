import { describe, it, expect } from "vitest";
import {
  RUBRIC_DIMENSIONS,
  aggregateScorecards,
  gapAngles,
  type PersonaScorecard,
} from "../../src/venture/rubric.js";

/** A persona scorecard with the same value in every rubric dimension. */
function uniform(value: number): PersonaScorecard {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, value])) as PersonaScorecard;
}

describe("venture rubric", () => {
  it("has the eight YC-bar dimensions from skills/idea-refine", () => {
    expect(RUBRIC_DIMENSIONS).toContain("problemSeverity");
    expect(RUBRIC_DIMENSIONS).toContain("marketPath");
    expect(RUBRIC_DIMENSIONS).toContain("novelInsight");
    expect(RUBRIC_DIMENSIONS).toContain("defensibility");
    expect(RUBRIC_DIMENSIONS).toContain("willingnessToPay");
    expect(RUBRIC_DIMENSIONS).toContain("tenXVsIncumbents");
    expect(RUBRIC_DIMENSIONS).toContain("distributionWedge");
    expect(RUBRIC_DIMENSIONS).toContain("whyNow");
    expect(RUBRIC_DIMENSIONS).toHaveLength(8);
  });

  it("maps agreeing personas to score*10 on the 0–100 scale", () => {
    expect(aggregateScorecards(uniform(7), uniform(7), 0.6)).toBe(70);
    expect(aggregateScorecards(uniform(0), uniform(0), 0.6)).toBe(0);
    expect(aggregateScorecards(uniform(10), uniform(10), 0.6)).toBe(100);
  });

  it("weights the adversarial Reviewer higher than the Advocate", () => {
    // Advocate loves it (10), Reviewer pans it (0). reviewerWeight 0.6 → combined 0.4*10 = 4 → 40.
    expect(aggregateScorecards(uniform(10), uniform(0), 0.6)).toBe(40);
    // A heavier reviewer weight pulls the aggregate further toward the skeptic.
    expect(aggregateScorecards(uniform(10), uniform(0), 0.8)).toBeLessThan(
      aggregateScorecards(uniform(10), uniform(0), 0.5),
    );
  });

  it("keeps the aggregate within 0–100", () => {
    const s = aggregateScorecards(uniform(10), uniform(3), 0.6);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });

  it("gapAngles surfaces the weak dimensions as angle strings", () => {
    const weakOnMarket: PersonaScorecard = { ...uniform(9), marketPath: 2, defensibility: 3 };
    const angles = gapAngles(weakOnMarket, weakOnMarket, 0.6);
    expect(angles).toContain("marketPath");
    expect(angles).toContain("defensibility");
    expect(angles).not.toContain("problemSeverity");
  });

  it("gapAngles is empty when every dimension is strong", () => {
    expect(gapAngles(uniform(9), uniform(9), 0.6)).toEqual([]);
  });
});
