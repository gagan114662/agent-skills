import { describe, it, expect } from "vitest";
import { aggregateVoiceMetrics, type VoiceInsightLike } from "../../src/voice/metrics.js";

function insight(p: Partial<VoiceInsightLike>): VoiceInsightLike {
  return {
    sentiment: p.sentiment ?? "neutral",
    churnRisk: p.churnRisk ?? "low",
    category: p.category ?? "support",
    sourceKind: p.sourceKind ?? "support_ticket",
    npsScore: p.npsScore ?? null,
  };
}

describe("voice/metrics — aggregateVoiceMetrics (#114)", () => {
  it("empty input → zeroed metrics with a null NPS (no responses)", () => {
    const m = aggregateVoiceMetrics([]);
    expect(m.total).toBe(0);
    expect(m.nps.score).toBeNull();
    expect(m.nps.responses).toBe(0);
    expect(m.sentiment).toEqual({ positive: 0, neutral: 0, negative: 0 });
  });

  it("counts sentiment, churn-risk, and category", () => {
    const m = aggregateVoiceMetrics([
      insight({ sentiment: "negative", churnRisk: "high", category: "bug" }),
      insight({ sentiment: "positive", churnRisk: "low", category: "praise" }),
      insight({ sentiment: "negative", churnRisk: "medium", category: "bug" }),
    ]);
    expect(m.total).toBe(3);
    expect(m.sentiment).toEqual({ positive: 1, neutral: 0, negative: 2 });
    expect(m.churnRisk).toEqual({ low: 1, medium: 1, high: 1 });
    expect(m.byCategory.bug).toBe(2);
    expect(m.byCategory.praise).toBe(1);
  });

  it("NPS score = %promoters − %detractors over NPS responses only (−100…100)", () => {
    const m = aggregateVoiceMetrics([
      insight({ sourceKind: "nps", npsScore: 10 }), // promoter
      insight({ sourceKind: "nps", npsScore: 9 }), // promoter
      insight({ sourceKind: "nps", npsScore: 8 }), // passive
      insight({ sourceKind: "nps", npsScore: 3 }), // detractor
      insight({ sourceKind: "support_ticket", npsScore: null }), // not an NPS response
    ]);
    expect(m.nps.responses).toBe(4);
    expect(m.nps.promoters).toBe(2);
    expect(m.nps.passives).toBe(1);
    expect(m.nps.detractors).toBe(1);
    // (2/4 - 1/4) * 100 = 25
    expect(m.nps.score).toBe(25);
  });
});
