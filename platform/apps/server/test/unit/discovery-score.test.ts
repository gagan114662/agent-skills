import { describe, it, expect } from "vitest";
import {
  detectQualifications,
  evaluateDef,
  pipelineMetrics,
  rankProspects,
  scoreProspect,
  UNVERIFIED_LABEL,
  type DiscoverySignalInput,
  type SignalDefInput,
} from "../../src/discovery/score.js";

const NOW = Date.parse("2026-06-14T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function sig(over: Partial<DiscoverySignalInput> = {}): DiscoverySignalInput {
  return {
    prospectKey: "p1",
    kind: "usage_event",
    value: 1,
    role: null,
    externalRef: null,
    occurredAtMs: NOW - DAY,
    ...over,
  };
}

function def(over: Partial<SignalDefInput> = {}): SignalDefInput {
  return {
    id: "def-power",
    kind: "power_user_threshold",
    threshold: 5,
    windowDays: 14,
    role: null,
    weight: 60,
    enabled: true,
    ...over,
  };
}

describe("discovery/score — evaluateDef (owner-defined qualifying signals)", () => {
  it("power_user_threshold qualifies when in-window usage value sums to the threshold", () => {
    const signals = [sig({ value: 3 }), sig({ value: 2 }), sig({ value: 1, occurredAtMs: NOW - 60 * DAY })];
    const m = evaluateDef(def({ threshold: 5 }), signals, NOW);
    expect(m).not.toBeNull();
    expect(m!.defKind).toBe("power_user_threshold");
    expect(m!.contributingSignalKinds).toContain("usage_event");
    // The out-of-window signal is excluded → exactly 5 counts, which meets (not exceeds-needed) threshold.
    expect(evaluateDef(def({ threshold: 6 }), signals, NOW)).toBeNull();
  });

  it("usage_trend qualifies only when recent usage exceeds older usage (trending up)", () => {
    const up = [
      sig({ value: 1, occurredAtMs: NOW - 13 * DAY }),
      sig({ value: 5, occurredAtMs: NOW - 1 * DAY }),
    ];
    const flat = [
      sig({ value: 5, occurredAtMs: NOW - 13 * DAY }),
      sig({ value: 1, occurredAtMs: NOW - 1 * DAY }),
    ];
    const d = def({ id: "def-trend", kind: "usage_trend", threshold: 3 });
    expect(evaluateDef(d, up, NOW)).not.toBeNull();
    expect(evaluateDef(d, flat, NOW)).toBeNull();
  });

  it("pricing_page_visit qualifies on a buying-intent signal", () => {
    const d = def({ id: "def-pricing", kind: "pricing_page_visit", threshold: 1 });
    expect(evaluateDef(d, [sig({ kind: "pricing_page_visit" })], NOW)).not.toBeNull();
    expect(evaluateDef(d, [sig({ kind: "usage_event" })], NOW)).toBeNull();
  });

  it("role_match qualifies on the owner's target role (case-insensitive)", () => {
    const d = def({ id: "def-role", kind: "role_match", role: "VP Engineering" });
    const match = evaluateDef(
      d,
      [sig({ kind: "role_identified", role: "vp engineering" })],
      NOW,
    );
    expect(match).not.toBeNull();
    expect(evaluateDef(d, [sig({ kind: "role_identified", role: "designer" })], NOW)).toBeNull();
  });

  it("a disabled definition never qualifies", () => {
    expect(evaluateDef(def({ enabled: false }), [sig({ value: 99 })], NOW)).toBeNull();
  });

  it("marks the match externally-grounded only when a contributing signal carries an external_ref", () => {
    const grounded = evaluateDef(
      def({ kind: "pricing_page_visit", threshold: 1 }),
      [sig({ kind: "pricing_page_visit", externalRef: "evt_123" })],
      NOW,
    );
    expect(grounded!.externallyGrounded).toBe(true);
    const ungrounded = evaluateDef(
      def({ kind: "pricing_page_visit", threshold: 1 }),
      [sig({ kind: "pricing_page_visit", externalRef: null })],
      NOW,
    );
    expect(ungrounded!.externallyGrounded).toBe(false);
  });
});

describe("discovery/score — detectQualifications (signal → PQL event)", () => {
  it("emits one PQL per newly-qualified (prospect, def), and excludes already-emitted ones", () => {
    const signals = [sig({ prospectKey: "vp-7", value: 6 })];
    const defs = [def({ threshold: 5 })];

    const first = detectQualifications(signals, defs, { nowMs: NOW });
    expect(first).toHaveLength(1);
    expect(first[0]!.prospectKey).toBe("vp-7");
    expect(first[0]!.defKind).toBe("power_user_threshold");
    expect(first[0]!.score).toBeGreaterThan(0);
    expect(first[0]!.verified).toBe(false); // no external_ref → prediction stays UNVERIFIED

    // Re-running with that pair already emitted produces NO new PQL (idempotent).
    const seen = new Set([`${first[0]!.prospectKey} ${first[0]!.defId}`]);
    const again = detectQualifications(signals, defs, { nowMs: NOW }, seen);
    expect(again).toHaveLength(0);
  });

  it("a PQL is verified when an externally-attributed signal grounded the qualification", () => {
    const signals = [sig({ prospectKey: "vp-8", kind: "pricing_page_visit", externalRef: "evt_9" })];
    const defs = [def({ id: "def-pricing", kind: "pricing_page_visit", threshold: 1 })];
    const out = detectQualifications(signals, defs, { nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.verified).toBe(true);
  });
});

describe("discovery/score — rankProspects (the daily ranked discovery queue)", () => {
  it("returns a NON-EMPTY queue for a seeded venture, each row labeled UNVERIFIED", () => {
    const signals: DiscoverySignalInput[] = [
      sig({ prospectKey: "vp-eng", kind: "usage_event", value: 9, occurredAtMs: NOW - 1 * DAY }),
      sig({ prospectKey: "vp-eng", kind: "pricing_page_visit", occurredAtMs: NOW - 1 * DAY }),
      sig({ prospectKey: "tire-kicker", kind: "usage_event", value: 1, occurredAtMs: NOW - 1 * DAY }),
    ];
    const defs = [
      def({ id: "def-power", threshold: 5, weight: 60 }),
      def({ id: "def-pricing", kind: "pricing_page_visit", threshold: 1, weight: 80 }),
    ];
    const queue = rankProspects(signals, defs, { nowMs: NOW, limit: 10 });

    expect(queue.length).toBeGreaterThan(0);
    const top = queue[0]!;
    expect(top.prospectKey).toBe("vp-eng"); // the qualified power user outranks the tire-kicker
    expect(top.likelihoodLabel).toBe(UNVERIFIED_LABEL);
    expect(top.scoreVerified).toBe(false);
    expect(top.score).toBeGreaterThan(0);
    expect(top.qualifyingDefs.length).toBeGreaterThanOrEqual(1);
    expect(top.qualifyingSignalKinds).toContain("usage_event");
    // tire-kicker matched no def → not in the queue.
    expect(queue.find((p) => p.prospectKey === "tire-kicker")).toBeUndefined();
  });

  it("honors the top-N limit and sorts by score descending", () => {
    const defs = [def({ threshold: 1, weight: 50 })];
    const signals = Array.from({ length: 5 }, (_, i) =>
      sig({ prospectKey: `p${i}`, value: i + 1, occurredAtMs: NOW - 1 * DAY }),
    );
    const queue = rankProspects(signals, defs, { nowMs: NOW, limit: 3 });
    expect(queue).toHaveLength(3);
    for (let i = 1; i < queue.length; i++) {
      expect(queue[i - 1]!.score).toBeGreaterThanOrEqual(queue[i]!.score);
    }
  });

  it("scoreProspect never exceeds 100 and is 0 with no matches", () => {
    expect(scoreProspect([], NOW, NOW)).toBe(0);
    const maxed = scoreProspect(
      [
        { defId: "a", defKind: "power_user_threshold", weight: 100, contributingSignalKinds: ["usage_event"], externallyGrounded: true },
        { defId: "b", defKind: "pricing_page_visit", weight: 100, contributingSignalKinds: ["pricing_page_visit"], externallyGrounded: true },
      ],
      NOW,
      NOW,
    );
    expect(maxed).toBeLessThanOrEqual(100);
    expect(maxed).toBeGreaterThan(0);
  });
});

describe("discovery/score — pipelineMetrics (5-stage GTM pipeline)", () => {
  it("returns all five stages with distinct-prospect counts + stage-to-stage conversions", () => {
    const m = pipelineMetrics([
      { prospectKey: "a", stage: "outreach", verified: false },
      { prospectKey: "b", stage: "outreach", verified: false },
      { prospectKey: "a", stage: "discovery", verified: false },
      { prospectKey: "a", stage: "conversion", verified: true },
    ]);
    expect(m.stages.map((s) => s.stage)).toEqual([
      "outreach",
      "discovery",
      "conversion",
      "onboarding",
      "post_sales",
    ]);
    const outreach = m.stages.find((s) => s.stage === "outreach")!;
    expect(outreach.prospects).toBe(2);
    const conversion = m.stages.find((s) => s.stage === "conversion")!;
    expect(conversion.prospects).toBe(1);
    expect(conversion.verifiedProspects).toBe(1);
    expect(m.totalProspects).toBe(2);
    // outreach(2) → discovery(1) conversion rate = 0.5; onboarding empty → 0.
    const o2d = m.stageConversions.find((c) => c.from === "outreach" && c.to === "discovery")!;
    expect(o2d.rate).toBeCloseTo(0.5);
    const c2o = m.stageConversions.find((c) => c.from === "conversion" && c.to === "onboarding")!;
    expect(c2o.rate).toBe(0);
  });
});
