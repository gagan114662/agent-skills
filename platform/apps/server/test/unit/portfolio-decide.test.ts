import { describe, it, expect } from "vitest";
import { portfolioHealth, decidePortfolio } from "../../src/portfolio/decide.js";
import { resolvePortfolioCaps, PORTFOLIO_DEFAULTS } from "../../src/portfolio/caps.js";
import type { PortfolioEvidence, PortfolioThresholds } from "../../src/portfolio/types.js";

const T: PortfolioThresholds = PORTFOLIO_DEFAULTS;

/** A healthy, well-past-grace launched venture with traction. Tests override fields. */
function evidence(over: Partial<PortfolioEvidence> = {}): PortfolioEvidence {
  return {
    ventureIdeaId: "idea-1",
    growthScore: 80,
    moatScore: 80,
    moatStagnant: false,
    demandSignals: 5,
    revenueCents: 100_00,
    monthlyCostCents: 10_00,
    ageInDays: 60,
    ...over,
  };
}

describe("portfolioHealth", () => {
  it("is the weight-normalized mean of growth, moat, and the bounded demand sub-score", () => {
    // demand sub-score = min(100, 5 * 20) = 100; all three = 100 → composite 100.
    expect(portfolioHealth(evidence({ growthScore: 100, moatScore: 100, demandSignals: 5 }), T)).toBe(
      100,
    );
    // growth 50, moat 0, demand 0 → (0.4*50 + 0.35*0 + 0.25*0) / (0.4+0.35+0.25) = 20.
    expect(
      portfolioHealth(evidence({ growthScore: 50, moatScore: 0, demandSignals: 0 }), T),
    ).toBeCloseTo(20, 6);
  });

  it("caps the demand sub-score at 100 regardless of signal count", () => {
    const a = portfolioHealth(evidence({ growthScore: 0, moatScore: 0, demandSignals: 5 }), T);
    const b = portfolioHealth(evidence({ growthScore: 0, moatScore: 0, demandSignals: 50 }), T);
    expect(a).toBe(b); // 5 signals already saturates (5 * 20 = 100)
    expect(a).toBeCloseTo(25, 6); // 0.25 * 100
  });

  it("clamps out-of-range inputs into [0,100]", () => {
    const s = portfolioHealth(
      evidence({ growthScore: 999, moatScore: -50, demandSignals: 0 }),
      T,
    );
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });

  it("never divides by zero when all weights are zero", () => {
    const zeroW: PortfolioThresholds = { ...T, weightGrowth: 0, weightMoat: 0, weightDemand: 0 };
    expect(portfolioHealth(evidence(), zeroW)).toBe(0);
  });
});

describe("decidePortfolio ladder", () => {
  it("holds a fresh launch at MAINTAIN inside the grace window (even when terrible)", () => {
    const a = decidePortfolio(
      evidence({ ageInDays: 3, growthScore: 0, moatScore: 0, demandSignals: 0, revenueCents: 0 }),
      T,
    );
    expect(a.decision).toBe("MAINTAIN");
    expect(a.reasons[0]).toMatch(/grace/i);
  });

  it("DOUBLE_DOWN when health is high AND the venture has traction", () => {
    const a = decidePortfolio(evidence({ growthScore: 95, moatScore: 90, demandSignals: 5 }), T);
    expect(a.decision).toBe("DOUBLE_DOWN");
    expect(a.score).toBeGreaterThanOrEqual(T.doubleDownScore);
    expect(a.hasTraction).toBe(true);
  });

  it("does NOT double-down on a high score without traction (no revenue, no demand)", () => {
    const a = decidePortfolio(
      evidence({ growthScore: 95, moatScore: 90, demandSignals: 0, revenueCents: 0, monthlyCostCents: 0 }),
      T,
    );
    expect(a.decision).not.toBe("DOUBLE_DOWN");
  });

  it("SUNSET on low composite health", () => {
    const a = decidePortfolio(
      evidence({ growthScore: 5, moatScore: 5, demandSignals: 0, revenueCents: 50, monthlyCostCents: 0 }),
      T,
    );
    expect(a.decision).toBe("SUNSET");
    expect(a.score).toBeLessThanOrEqual(T.sunsetScore);
  });

  it("SUNSET when burning money with zero traction (the economic kill), even at a mid score", () => {
    // mid health but real cost + no revenue + no demand → kill.
    const a = decidePortfolio(
      evidence({
        growthScore: 60,
        moatScore: 60,
        demandSignals: 0,
        revenueCents: 0,
        monthlyCostCents: 5_00,
      }),
      T,
    );
    expect(a.decision).toBe("SUNSET");
    expect(a.hasTraction).toBe(false);
    expect(a.netCents).toBeLessThan(0);
    expect(a.reasons.join(" ")).toMatch(/burn|traction/i);
  });

  it("PIVOT when moat is stagnant and there's no traction but it isn't burning (cheap to retry)", () => {
    const a = decidePortfolio(
      evidence({
        growthScore: 55,
        moatScore: 55,
        moatStagnant: true,
        demandSignals: 0,
        revenueCents: 0,
        monthlyCostCents: 0,
      }),
      T,
    );
    expect(a.decision).toBe("PIVOT");
    expect(a.reasons.join(" ")).toMatch(/stagnant|pivot/i);
  });

  it("MAINTAIN in the healthy middle (traction, not stagnant, not double-down)", () => {
    const a = decidePortfolio(
      evidence({ growthScore: 50, moatScore: 50, demandSignals: 1, revenueCents: 10, monthlyCostCents: 5 }),
      T,
    );
    expect(a.decision).toBe("MAINTAIN");
  });

  it("carries the ventureIdeaId through", () => {
    expect(decidePortfolio(evidence({ ventureIdeaId: "idea-xyz" }), T).ventureIdeaId).toBe("idea-xyz");
  });
});

describe("resolvePortfolioCaps", () => {
  it("is default OFF with the documented hard defaults", () => {
    const c = resolvePortfolioCaps(undefined);
    expect(c.enabled).toBe(false);
    expect(c.doubleDownScore).toBe(70);
    expect(c.sunsetScore).toBe(25);
    expect(c.minReviewAgeDays).toBe(14);
  });

  it("overrides only the provided fields", () => {
    const c = resolvePortfolioCaps({ enabled: true, sunsetScore: 40 });
    expect(c.enabled).toBe(true);
    expect(c.sunsetScore).toBe(40);
    expect(c.doubleDownScore).toBe(70); // untouched default
  });
});
