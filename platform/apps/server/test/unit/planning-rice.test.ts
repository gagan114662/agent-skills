import { describe, it, expect } from "vitest";
import { deriveRice, scoreRice, rankBacklog, IMPACT_MULTIPLIERS } from "../../src/planning/rice.js";
import type { BacklogItemRecord } from "../../src/planning/types.js";

/** A backlog item fixture; override the RICE inputs + ordering fields per test. */
function item(over: Partial<BacklogItemRecord> = {}): BacklogItemRecord {
  return {
    id: "i1",
    workspaceId: "w1",
    ideaId: null,
    title: "t",
    description: "",
    source: "growth",
    sourceRef: "",
    reach: 0,
    impact: 2,
    confidencePct: 100,
    effort: 1,
    isPivot: false,
    status: "proposed",
    targetChannelId: null,
    targetAgentMemberId: null,
    specId: null,
    approvalRequestId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("deriveRice: evidence counts → stored RICE inputs", () => {
  it("maps signal count → reach, severity tier → impact, corroborating sources → confidence%, effort → effort", () => {
    expect(
      deriveRice({ signalCount: 100, severityTier: 2, corroboratingSources: 2, effortPoints: 4 }),
    ).toEqual({ reach: 100, impact: 2, confidencePct: 80, effort: 4 });
  });

  it("confidence rises with corroborating sources: 0→0, 1→50, 2→80, 3+→100 (the RICE confidence ladder)", () => {
    const base = { signalCount: 10, severityTier: 1, effortPoints: 1 };
    expect(deriveRice({ ...base, corroboratingSources: 0 }).confidencePct).toBe(0);
    expect(deriveRice({ ...base, corroboratingSources: 1 }).confidencePct).toBe(50);
    expect(deriveRice({ ...base, corroboratingSources: 2 }).confidencePct).toBe(80);
    expect(deriveRice({ ...base, corroboratingSources: 5 }).confidencePct).toBe(100);
  });

  it("clamps a negative signal count to 0, an out-of-range severity tier into 0..4, and effort to ≥ 1", () => {
    const r = deriveRice({ signalCount: -5, severityTier: 9, corroboratingSources: 2, effortPoints: 0 });
    expect(r.reach).toBe(0);
    expect(r.impact).toBe(4);
    expect(r.effort).toBe(1);
  });
});

describe("scoreRice: (Reach × Impact × Confidence) / Effort", () => {
  it("computes the canonical RICE score from the stored inputs", () => {
    // reach 100 × impact-tier-2 (×1) × confidence 0.8 / effort 4 = 20
    expect(scoreRice({ reach: 100, impact: 2, confidencePct: 80, effort: 4 })).toBeCloseTo(20, 5);
  });

  it("maps the severity tier to the standard RICE impact multipliers (0.25/0.5/1/2/3)", () => {
    expect(IMPACT_MULTIPLIERS).toEqual([0.25, 0.5, 1, 2, 3]);
    expect(scoreRice({ reach: 10, impact: 4, confidencePct: 100, effort: 1 })).toBeCloseTo(30, 5);
    expect(scoreRice({ reach: 10, impact: 0, confidencePct: 100, effort: 1 })).toBeCloseTo(2.5, 5);
  });

  it("guards a zero/negative effort to 1 (never divides by zero) and clamps confidence into [0,100]", () => {
    expect(scoreRice({ reach: 8, impact: 2, confidencePct: 100, effort: 0 })).toBeCloseTo(8, 5);
    expect(scoreRice({ reach: 8, impact: 2, confidencePct: 250, effort: 1 })).toBeCloseTo(8, 5);
  });
});

describe("rankBacklog: highest RICE first, stable, ties by recency", () => {
  it("orders items by descending score and assigns 1-based positions", () => {
    const low = item({ id: "low", reach: 10, effort: 10 }); // score 1
    const high = item({ id: "high", reach: 100, effort: 1 }); // score 100
    const mid = item({ id: "mid", reach: 50, effort: 5 }); // score 10
    const ranked = rankBacklog([low, high, mid]);
    expect(ranked.map((r) => r.item.id)).toEqual(["high", "mid", "low"]);
    expect(ranked.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(ranked[0].score).toBeCloseTo(100, 5);
  });

  it("breaks score ties by most-recent createdAt (the freshest evidence wins)", () => {
    const older = item({ id: "older", reach: 10, effort: 1, createdAt: new Date("2026-01-01T00:00:00Z") });
    const newer = item({ id: "newer", reach: 10, effort: 1, createdAt: new Date("2026-02-01T00:00:00Z") });
    const ranked = rankBacklog([older, newer]);
    expect(ranked.map((r) => r.item.id)).toEqual(["newer", "older"]);
  });

  it("does not mutate the input array", () => {
    const items = [item({ id: "a", reach: 1 }), item({ id: "b", reach: 99 })];
    const before = items.map((i) => i.id);
    rankBacklog(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it("surfaces the RICE breakdown (impact multiplier + confidence fraction) for display", () => {
    const ranked = rankBacklog([item({ reach: 100, impact: 3, confidencePct: 80, effort: 2 })]);
    expect(ranked[0].rice).toEqual({ reach: 100, impact: 2, confidence: 0.8, effort: 2 });
  });
});
