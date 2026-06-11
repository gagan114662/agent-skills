import { describe, it, expect } from "vitest";
import {
  funnelFromEvents,
  funnelRates,
  scoreGrowth,
  growthToVentureSignal,
  recommendExperiments,
  DEFAULT_GROWTH_WEIGHTS,
} from "../../src/growth/score.js";
import { resolveGrowthCaps, GROWTH_DEFAULTS } from "../../src/growth/caps.js";
import {
  isGrowthEventKind,
  isExperimentStatus,
  type GrowthEventRecord,
} from "../../src/growth/types.js";

/** A baseline growth event; override per-case. */
function ev(over: Partial<GrowthEventRecord> = {}): GrowthEventRecord {
  return {
    id: "e-1",
    workspaceId: "w-1",
    ideaId: null,
    kind: "acquisition",
    source: "organic",
    value: 1,
    metadata: {},
    occurredAt: new Date("2026-06-01T00:00:00Z"),
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...over,
  };
}

describe("type guards", () => {
  it("isGrowthEventKind accepts the funnel kinds, rejects others", () => {
    expect(isGrowthEventKind("acquisition")).toBe(true);
    expect(isGrowthEventKind("retention")).toBe(true);
    expect(isGrowthEventKind("signup")).toBe(false);
    expect(isGrowthEventKind(7)).toBe(false);
  });
  it("isExperimentStatus accepts the lifecycle, rejects others", () => {
    expect(isExperimentStatus("proposed")).toBe(true);
    expect(isExperimentStatus("completed")).toBe(true);
    expect(isExperimentStatus("deleted")).toBe(false);
  });
});

describe("funnelFromEvents (#102 instrumentation → funnel)", () => {
  it("sums value per kind, ignores negative values and unknown kinds", () => {
    const f = funnelFromEvents([
      ev({ kind: "acquisition", value: 100 }),
      ev({ kind: "acquisition", value: 50 }),
      ev({ kind: "activation", value: 40 }),
      ev({ kind: "conversion", value: 10 }),
      ev({ kind: "retention", value: 8 }),
      ev({ kind: "acquisition", value: -5 }), // negative weight ignored
    ]);
    expect(f).toEqual({ acquisition: 150, activation: 40, conversion: 10, retention: 8 });
  });
  it("is all-zero for no events", () => {
    expect(funnelFromEvents([])).toEqual({ acquisition: 0, activation: 0, conversion: 0, retention: 0 });
  });
});

describe("funnelRates (guarded ratios in [0,1])", () => {
  it("divide-by-zero yields 0, not NaN/Infinity", () => {
    const r = funnelRates({ acquisition: 0, activation: 0, conversion: 0, retention: 0 });
    expect(r).toEqual({ activationRate: 0, conversionRate: 0, retentionRate: 0 });
  });
  it("computes activation/acquisition, conversion/activation, retention/activation", () => {
    const r = funnelRates({ acquisition: 100, activation: 40, conversion: 10, retention: 20 });
    expect(r.activationRate).toBeCloseTo(0.4);
    expect(r.conversionRate).toBeCloseTo(0.25);
    expect(r.retentionRate).toBeCloseTo(0.5);
  });
  it("clamps an over-unity ratio (more activations than acquisitions) to 1", () => {
    const r = funnelRates({ acquisition: 10, activation: 50, conversion: 0, retention: 0 });
    expect(r.activationRate).toBe(1);
  });
});

describe("scoreGrowth (0–100 weighted funnel)", () => {
  const caps = resolveGrowthCaps({ enabled: true });

  it("is 0 when acquisition is below the minTrafficForScore floor (not enough signal)", () => {
    const strict = resolveGrowthCaps({ enabled: true, minTrafficForScore: 100 });
    const s = scoreGrowth({ acquisition: 50, activation: 50, conversion: 50, retention: 50 }, strict);
    expect(s.score).toBe(0);
  });
  it("a perfect funnel (every stage 1.0) scores 100", () => {
    const s = scoreGrowth({ acquisition: 10, activation: 10, conversion: 10, retention: 10 }, caps);
    expect(s.score).toBe(100);
  });
  it("weights the three rates (activation .4 / conversion .35 / retention .25)", () => {
    // activationRate 1, conversionRate 0, retentionRate 0 → 0.4 * 100 = 40
    const s = scoreGrowth({ acquisition: 10, activation: 10, conversion: 0, retention: 0 }, caps);
    expect(s.score).toBeCloseTo(40);
    expect(DEFAULT_GROWTH_WEIGHTS.activation + DEFAULT_GROWTH_WEIGHTS.conversion + DEFAULT_GROWTH_WEIGHTS.retention).toBeCloseTo(1);
  });
  it("carries the funnel + rates through for the dashboard", () => {
    const s = scoreGrowth({ acquisition: 100, activation: 40, conversion: 10, retention: 20 }, caps);
    expect(s.funnel.acquisition).toBe(100);
    expect(s.rates.activationRate).toBeCloseTo(0.4);
  });
});

describe("growthToVentureSignal (#96 scorecard seam: 0–100 → 0–10)", () => {
  it("maps the score onto the rubric band and clamps", () => {
    expect(growthToVentureSignal(0)).toBe(0);
    expect(growthToVentureSignal(100)).toBe(10);
    expect(growthToVentureSignal(55)).toBeCloseTo(5.5);
    expect(growthToVentureSignal(250)).toBe(10);
  });
});

describe("recommendExperiments (#107/#123 next-experiments, weakest stage first)", () => {
  it("orders the three stages weakest-rate first", () => {
    // activation .4, conversion .1, retention .8 → conversion weakest, then activation, then retention
    const suggestions = recommendExperiments({ acquisition: 100, activation: 40, conversion: 4, retention: 32 });
    expect(suggestions.map((s) => s.stage)).toEqual(["conversion", "activation", "retention"]);
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0].hypothesis).toBeTruthy();
    expect(suggestions[0].channel).toBeTruthy();
  });
  it("preserves stable order on ties (activation, conversion, retention)", () => {
    const suggestions = recommendExperiments({ acquisition: 0, activation: 0, conversion: 0, retention: 0 });
    expect(suggestions.map((s) => s.stage)).toEqual(["activation", "conversion", "retention"]);
  });
});

describe("resolveGrowthCaps", () => {
  it("is default-OFF", () => {
    const caps = resolveGrowthCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps).toEqual(GROWTH_DEFAULTS);
  });
  it("overrides only provided fields", () => {
    const caps = resolveGrowthCaps({ enabled: true, minTrafficForScore: 25 });
    expect(caps.enabled).toBe(true);
    expect(caps.minTrafficForScore).toBe(25);
  });
});
