import { describe, it, expect } from "vitest";
import { detectIntent } from "../../src/hot-prospect/detect.js";
import type { HotProspectPolicy, IntentRule } from "../../src/hot-prospect/caps.js";
import type { ProspectActivity, ProspectSignal, ProspectSignalKind } from "../../src/hot-prospect/types.js";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** Small, explicit model so the arithmetic in assertions is trivial and stable. */
const RULES: readonly IntentRule[] = [
  { kind: "pricing_view", label: "Pricing", weight: 10, saturateAt: 3, burstThreshold: 3 },
  { kind: "doc_view", label: "Docs", weight: 5, saturateAt: 2, burstThreshold: 0 },
];

const POLICY: HotProspectPolicy = {
  enabled: true,
  windowMs: 24 * HOUR,
  scoreThreshold: 12,
  cooldownMs: 24 * HOUR,
  rules: RULES,
};

function sig(kind: ProspectSignalKind, hoursAgo: number): ProspectSignal {
  return { kind, at: new Date(NOW - hoursAgo * HOUR).toISOString() };
}

function activity(signals: ProspectSignal[], prospectId = "p1"): ProspectActivity {
  return { prospectId, signals };
}

describe("detectIntent — burst rules (the '3x today' trigger)", () => {
  it("fires a burst rule when a kind crosses its threshold inside the window", () => {
    const d = detectIntent(activity([sig("pricing_view", 0), sig("pricing_view", 1), sig("pricing_view", 2)]), POLICY, NOW);
    expect(d.isHot).toBe(true);
    expect(d.firedRules).toHaveLength(1);
    expect(d.firedRules[0]).toMatchObject({ kind: "pricing_view", count: 3, threshold: 3 });
    expect(d.counts.pricing_view).toBe(3);
    expect(d.reason).toContain("Pricing");
  });

  it("does not fire a burst below the threshold, and stays cold when the score is below the line", () => {
    const d = detectIntent(activity([sig("pricing_view", 0), sig("pricing_view", 1)]), POLICY, NOW);
    // 2 pricing views → round(10 * 2/3) = 7, below scoreThreshold 12, no burst (2 < 3).
    expect(d.firedRules).toHaveLength(0);
    expect(d.score).toBe(7);
    expect(d.isHot).toBe(false);
  });
});

describe("detectIntent — weighted-score path", () => {
  it("becomes hot via the score threshold even when no single burst rule fires", () => {
    // 2 pricing (round(10*2/3)=7) + 2 docs (round(5*1)=5) = 12 >= 12, no burst (pricing 2<3, docs no burst).
    const d = detectIntent(
      activity([sig("pricing_view", 0), sig("pricing_view", 1), sig("doc_view", 0), sig("doc_view", 2)]),
      POLICY,
      NOW,
    );
    expect(d.firedRules).toHaveLength(0);
    expect(d.score).toBe(12);
    expect(d.isHot).toBe(true);
    expect(d.reason).toContain("score");
  });

  it("saturates a runaway metric so one kind cannot dominate", () => {
    const many = Array.from({ length: 9 }, (_, i) => sig("pricing_view", i));
    const d = detectIntent(activity(many), POLICY, NOW);
    // 9 pricing views still cap at the saturating weight (10), though the burst count reports the real 9.
    expect(d.score).toBe(10);
    expect(d.firedRules[0]?.count).toBe(9);
  });
});

describe("detectIntent — windowing + bad input", () => {
  it("ignores signals older than the window", () => {
    const d = detectIntent(
      activity([sig("pricing_view", 0), sig("pricing_view", 1), sig("pricing_view", 48)]),
      POLICY,
      NOW,
    );
    // The 48h-old visit falls outside the 24h window → only 2 counted → no burst, score 7, cold.
    expect(d.counts.pricing_view).toBe(2);
    expect(d.isHot).toBe(false);
  });

  it("ignores future-dated and unparseable timestamps", () => {
    const d = detectIntent(
      activity([
        sig("pricing_view", 0),
        sig("pricing_view", 1),
        { kind: "pricing_view", at: new Date(NOW + HOUR).toISOString() }, // future
        { kind: "pricing_view", at: "not-a-date" }, // unparseable
      ]),
      POLICY,
      NOW,
    );
    expect(d.counts.pricing_view).toBe(2);
    expect(d.isHot).toBe(false);
  });

  it("scores a prospect with no signals as cold", () => {
    const d = detectIntent(activity([]), POLICY, NOW);
    expect(d.score).toBe(0);
    expect(d.isHot).toBe(false);
    expect(d.firedRules).toHaveLength(0);
  });
});
