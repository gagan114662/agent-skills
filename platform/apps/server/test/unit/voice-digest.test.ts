import { describe, it, expect } from "vitest";
import { buildVoiceDigest } from "../../src/voice/digest.js";
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

describe("voice/digest — buildVoiceDigest (the weekly voice-of-customer digest) (#114)", () => {
  it("rolls up totals, NPS, high-churn count, top themes, and tickets needing a human", () => {
    const metrics = aggregateVoiceMetrics([
      insight({ category: "bug", sentiment: "negative", churnRisk: "high" }),
      insight({ category: "bug", sentiment: "negative", churnRisk: "high" }),
      insight({ category: "pricing", churnRisk: "medium" }),
      insight({ sourceKind: "nps", npsScore: 10 }),
      insight({ sourceKind: "nps", npsScore: 2 }),
    ]);
    const digest = buildVoiceDigest({ windowDays: 7, metrics, ticketsNeedingHuman: 4 });

    expect(digest.windowDays).toBe(7);
    expect(digest.totalSignals).toBe(5);
    expect(digest.churnHigh).toBe(2);
    expect(digest.ticketsNeedingHuman).toBe(4);
    expect(digest.npsScore).toBe(metrics.nps.score);
    // top theme is the most-frequent category
    expect(digest.topThemes[0].category).toBe("bug");
    expect(digest.topThemes[0].count).toBe(2);
    // headline mentions the signal count and the human-attention count
    expect(digest.headline).toContain("5");
    expect(digest.headline).toContain("4");
  });

  it("handles an empty window (no signals, n/a NPS)", () => {
    const digest = buildVoiceDigest({ windowDays: 7, metrics: aggregateVoiceMetrics([]), ticketsNeedingHuman: 0 });
    expect(digest.totalSignals).toBe(0);
    expect(digest.npsScore).toBeNull();
    expect(digest.topThemes).toEqual([]);
    expect(typeof digest.headline).toBe("string");
  });
});
