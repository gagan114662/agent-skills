/**
 * Unit tests for the lead-scoring MODEL (issue #611): `scoreLead` and its explainability invariants.
 *
 * The contract these pin:
 *   - behavior (intent) outweighs firmographics (fit) — a hand-raise beats a pretty logo;
 *   - the score is EXPLAINABLE: the per-factor `points` always sum to the pre-clamp subtotal, and `score`
 *     is that total clamped to 0–100;
 *   - recency decays stale intent;
 *   - a genuinely poor fit can pull a lead down (negative firmographic factors), clamped at 0.
 */

import { describe, it, expect } from "vitest";
import {
  scoreLead,
  BEHAVIOR_MAX,
  FIRMO_MAX,
  type LeadInput,
  type LeadScore,
} from "../../src/lead-scoring/index.js";

/** A lead saturated on every behavior signal AND a perfect firmographic fit, active this week → a perfect 100. */
const PERFECT: LeadInput = {
  leadId: "perfect",
  behavior: {
    pricingVisits: 5,
    demoSessions: 3,
    demoMinutes: 30,
    emailClicks: 4,
    emailOpens: 8,
    siteVisits: 10,
    daysSinceLastActivity: 2,
  },
  firmographics: {
    employeeCount: 120,
    annualRevenueUsd: 50_000_000,
    industryFit: "core",
    role: "decision_maker",
    region: "core",
  },
};

/** The explainability invariant: factor points sum to the subtotal, and score is the clamped total. */
function assertExplainable(s: LeadScore): void {
  const factorSum = s.factors.reduce((acc, f) => acc + f.points, 0);
  expect(factorSum).toBe(s.behaviorScore + s.firmographicScore);
  expect(s.score).toBe(Math.min(100, Math.max(0, s.behaviorScore + s.firmographicScore)));
}

describe("scoreLead — model", () => {
  it("a fully-saturated, perfect-fit, recent lead scores exactly 100 (hot)", () => {
    const s = scoreLead(PERFECT);
    expect(s.behaviorScore).toBe(BEHAVIOR_MAX);
    expect(s.firmographicScore).toBe(FIRMO_MAX);
    expect(s.score).toBe(100);
    expect(s.band).toBe("hot");
    assertExplainable(s);
  });

  it("an empty lead scores 0 (cold) with no factors", () => {
    const s = scoreLead({ leadId: "empty" });
    expect(s.score).toBe(0);
    expect(s.band).toBe("cold");
    expect(s.factors).toHaveLength(0);
    assertExplainable(s);
  });

  it("intent outweighs fit: max behavior (no firmo) beats max firmo (no behavior)", () => {
    const allIntent = scoreLead({ leadId: "intent", behavior: PERFECT.behavior });
    const allFit = scoreLead({ leadId: "fit", firmographics: PERFECT.firmographics });
    expect(allIntent.behaviorScore).toBe(BEHAVIOR_MAX); // 60
    expect(allFit.firmographicScore).toBe(FIRMO_MAX); // 40
    expect(allIntent.score).toBeGreaterThan(allFit.score);
  });

  it("the explanation is auditable: factor points sum to the subtotal for every shape of lead", () => {
    const samples: LeadInput[] = [
      { leadId: "a", behavior: { pricingVisits: 2, emailOpens: 3 } },
      { leadId: "b", firmographics: { industryFit: "adjacent", role: "champion", employeeCount: 800 } },
      { leadId: "c", behavior: { demoSessions: 1, daysSinceLastActivity: 45 }, firmographics: { region: "expansion" } },
      { leadId: "d", behavior: { siteVisits: 1 }, firmographics: { industryFit: "off", region: "unsupported" } },
    ];
    for (const lead of samples) assertExplainable(scoreLead(lead));
  });

  it("factors are sorted by absolute impact, descending (biggest reason first)", () => {
    const s = scoreLead(PERFECT);
    for (let i = 1; i < s.factors.length; i++) {
      const prev = s.factors[i - 1];
      const cur = s.factors[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      expect(Math.abs(prev!.points)).toBeGreaterThanOrEqual(Math.abs(cur!.points));
    }
  });

  it("pricing-page visits are the strongest single intent signal", () => {
    const pricing = scoreLead({ leadId: "p", behavior: { pricingVisits: 3, daysSinceLastActivity: 1 } });
    const opens = scoreLead({ leadId: "o", behavior: { emailOpens: 5, daysSinceLastActivity: 1 } });
    expect(pricing.score).toBeGreaterThan(opens.score);
    const pricingFactor = pricing.factors.find((f) => f.key === "pricing_visits");
    expect(pricingFactor?.points).toBe(20);
  });

  it("recency decays stale intent and records the decay as a (negative) factor", () => {
    const fresh = scoreLead({ leadId: "fresh", behavior: { pricingVisits: 3, daysSinceLastActivity: 3 } });
    const stale = scoreLead({ leadId: "stale", behavior: { pricingVisits: 3, daysSinceLastActivity: 60 } });
    expect(fresh.behaviorScore).toBe(20);
    expect(stale.behaviorScore).toBe(10); // 20 × 0.5 (last quarter tier)
    expect(stale.score).toBeLessThan(fresh.score);
    const decay = stale.factors.find((f) => f.key === "recency");
    expect(decay?.points).toBe(-10);
  });

  it("missing recency applies no decay (absence is never penalized)", () => {
    const noRecency = scoreLead({ leadId: "x", behavior: { pricingVisits: 3 } });
    expect(noRecency.behaviorScore).toBe(20);
    expect(noRecency.factors.some((f) => f.key === "recency")).toBe(false);
  });

  it("a poor fit pulls the score down and clamps at 0, never negative", () => {
    const bad = scoreLead({
      leadId: "bad",
      firmographics: { industryFit: "off", region: "unsupported" },
    });
    expect(bad.firmographicScore).toBe(-14); // -8 off industry, -6 unsupported region
    expect(bad.score).toBe(0); // clamped, not negative
    expect(bad.band).toBe("cold");
    assertExplainable(bad);
  });

  it("bands track the documented thresholds (cold <20, cool 20–44, warm 45–69, hot ≥70)", () => {
    expect(scoreLead({ leadId: "cold", behavior: { emailOpens: 1 } }).band).toBe("cold"); // ~1 pt
    expect(scoreLead({ leadId: "cool", behavior: { pricingVisits: 3, daysSinceLastActivity: 1 } }).band).toBe("cool"); // 20
    expect(scoreLead({ leadId: "warm", behavior: PERFECT.behavior }).band).toBe("warm"); // 60
    expect(scoreLead(PERFECT).band).toBe("hot"); // 100
  });

  it("garbage counts (negative / NaN) are treated as no signal, not errors", () => {
    const s = scoreLead({
      leadId: "garbage",
      behavior: { pricingVisits: -5, emailOpens: Number.NaN, demoSessions: Infinity },
    });
    expect(s.score).toBe(0);
    expect(s.factors).toHaveLength(0);
  });
});
