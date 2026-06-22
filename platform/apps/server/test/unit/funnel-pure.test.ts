import { describe, it, expect } from "vitest";
import {
  FUNNEL_STAGES,
  FUNNEL_SURFACES,
  UNATTRIBUTED_AGENT,
  UNATTRIBUTED_CHANNEL,
  isFunnelStage,
  isFunnelSurface,
  normalizeFunnelEvent,
  type FunnelEvent,
} from "../../src/analytics/funnel/schema.js";
import {
  aggregateFunnel,
  countsFromEvents,
  stageRates,
} from "../../src/analytics/funnel/aggregate.js";

/** A baseline funnel event; override per-case. */
function ev(over: Partial<FunnelEvent> = {}): FunnelEvent {
  return {
    workspaceId: "w-1",
    stage: "visit",
    surface: "marketing",
    channel: "organic",
    agent: "scout",
    value: 1,
    occurredAt: new Date("2026-06-01T00:00:00Z"),
    metadata: {},
    ...over,
  };
}

describe("funnel schema (the consistent cross-surface contract, #604)", () => {
  it("names the four full-funnel stages in order", () => {
    expect(FUNNEL_STAGES).toEqual(["visit", "signup", "activation", "paid"]);
  });
  it("isFunnelStage accepts the four stages, rejects others", () => {
    expect(isFunnelStage("visit")).toBe(true);
    expect(isFunnelStage("paid")).toBe(true);
    expect(isFunnelStage("acquisition")).toBe(false); // the #102 vocabulary, not this funnel
    expect(isFunnelStage(7)).toBe(false);
  });
  it("isFunnelSurface accepts marketing + product only", () => {
    expect(FUNNEL_SURFACES).toEqual(["marketing", "product"]);
    expect(isFunnelSurface("marketing")).toBe(true);
    expect(isFunnelSurface("product")).toBe(true);
    expect(isFunnelSurface("server")).toBe(false);
  });
});

describe("normalizeFunnelEvent (the shared ingest entry point)", () => {
  const now = () => 1_700_000_000_000;

  it("fills defaults: surface=marketing, value=1, channel/agent unattributed, now() timestamp", () => {
    const e = normalizeFunnelEvent("w-9", { stage: "visit" }, now);
    expect(e).toEqual({
      workspaceId: "w-9",
      stage: "visit",
      surface: "marketing",
      channel: UNATTRIBUTED_CHANNEL,
      agent: UNATTRIBUTED_AGENT,
      value: 1,
      occurredAt: new Date(1_700_000_000_000),
      metadata: {},
    });
  });

  it("preserves a provided surface, channel, agent, value, metadata and explicit occurredAt", () => {
    const e = normalizeFunnelEvent(
      "w-9",
      {
        stage: "paid",
        surface: "product",
        channel: "producthunt",
        agent: "mark",
        value: 3,
        occurredAtMs: 1_699_000_000_000,
        metadata: { plan: "pro" },
      },
      now,
    );
    expect(e.stage).toBe("paid");
    expect(e.surface).toBe("product");
    expect(e.channel).toBe("producthunt");
    expect(e.agent).toBe("mark");
    expect(e.value).toBe(3);
    expect(e.occurredAt).toEqual(new Date(1_699_000_000_000));
    expect(e.metadata).toEqual({ plan: "pro" });
  });

  it("trims and lowercases channel/agent so breakdown keys stay stable", () => {
    const e = normalizeFunnelEvent("w-9", { stage: "signup", channel: "  ProductHunt ", agent: " Scout " }, now);
    expect(e.channel).toBe("producthunt");
    expect(e.agent).toBe("scout");
  });

  it("blank channel/agent collapse to the unattributed labels", () => {
    const e = normalizeFunnelEvent("w-9", { stage: "signup", channel: "   ", agent: "" }, now);
    expect(e.channel).toBe(UNATTRIBUTED_CHANNEL);
    expect(e.agent).toBe(UNATTRIBUTED_AGENT);
  });

  it("rejects an unknown stage", () => {
    expect(() => normalizeFunnelEvent("w-9", { stage: "purchase" }, now)).toThrow(/stage/);
  });
  it("rejects an unknown surface", () => {
    expect(() => normalizeFunnelEvent("w-9", { stage: "visit", surface: "email" }, now)).toThrow(/surface/);
  });
  it("rejects a non-positive value (a funnel count is never <= 0)", () => {
    expect(() => normalizeFunnelEvent("w-9", { stage: "visit", value: 0 }, now)).toThrow(/value/);
    expect(() => normalizeFunnelEvent("w-9", { stage: "visit", value: -2 }, now)).toThrow(/value/);
  });
  it("requires a workspaceId", () => {
    expect(() => normalizeFunnelEvent("", { stage: "visit" }, now)).toThrow(/workspace/i);
  });
});

describe("countsFromEvents (sum value per stage)", () => {
  it("sums value per stage, ignores non-positive values", () => {
    const c = countsFromEvents([
      ev({ stage: "visit", value: 100 }),
      ev({ stage: "visit", value: 50 }),
      ev({ stage: "signup", value: 20 }),
      ev({ stage: "activation", value: 8 }),
      ev({ stage: "paid", value: 3 }),
      ev({ stage: "visit", value: -5 }), // ignored
    ]);
    expect(c).toEqual({ visit: 150, signup: 20, activation: 8, paid: 3 });
  });
  it("is all-zero for no events", () => {
    expect(countsFromEvents([])).toEqual({ visit: 0, signup: 0, activation: 0, paid: 0 });
  });
});

describe("stageRates (guarded conversion ratios in [0,1])", () => {
  it("divide-by-zero yields 0, never NaN/Infinity", () => {
    expect(stageRates({ visit: 0, signup: 0, activation: 0, paid: 0 })).toEqual({
      signupRate: 0,
      activationRate: 0,
      paidRate: 0,
      overallRate: 0,
    });
  });
  it("computes signup/visit, activation/signup, paid/activation, paid/visit", () => {
    const r = stageRates({ visit: 1000, signup: 100, activation: 40, paid: 10 });
    expect(r.signupRate).toBeCloseTo(0.1);
    expect(r.activationRate).toBeCloseTo(0.4);
    expect(r.paidRate).toBeCloseTo(0.25);
    expect(r.overallRate).toBeCloseTo(0.01);
  });
  it("clamps an over-unity ratio to 1", () => {
    const r = stageRates({ visit: 10, signup: 50, activation: 0, paid: 0 });
    expect(r.signupRate).toBe(1);
  });
});

describe("aggregateFunnel (the one funnel view, broken down by channel + agent)", () => {
  const events: FunnelEvent[] = [
    // producthunt, driven by mark
    ev({ stage: "visit", channel: "producthunt", agent: "mark", value: 80 }),
    ev({ stage: "signup", channel: "producthunt", agent: "mark", value: 16 }),
    ev({ stage: "activation", channel: "producthunt", agent: "mark", value: 8 }),
    ev({ stage: "paid", channel: "producthunt", agent: "mark", value: 2 }),
    // organic, driven by scout
    ev({ stage: "visit", channel: "organic", agent: "scout", value: 20 }),
    ev({ stage: "signup", channel: "organic", agent: "scout", value: 4 }),
  ];

  it("rolls up overall counts + rates across every channel and agent", () => {
    const view = aggregateFunnel(events);
    expect(view.counts).toEqual({ visit: 100, signup: 20, activation: 8, paid: 2 });
    expect(view.rates.signupRate).toBeCloseTo(0.2);
    expect(view.rates.activationRate).toBeCloseTo(0.4);
    expect(view.rates.paidRate).toBeCloseTo(0.25);
    expect(view.rates.overallRate).toBeCloseTo(0.02);
    expect(view.eventCount).toBe(6);
  });

  it("breaks the funnel down by channel, each row carrying its own counts + rates", () => {
    const view = aggregateFunnel(events);
    const ph = view.byChannel.find((r) => r.key === "producthunt")!;
    const organic = view.byChannel.find((r) => r.key === "organic")!;
    expect(ph.counts).toEqual({ visit: 80, signup: 16, activation: 8, paid: 2 });
    expect(ph.rates.signupRate).toBeCloseTo(0.2);
    expect(ph.rates.paidRate).toBeCloseTo(0.25);
    expect(organic.counts).toEqual({ visit: 20, signup: 4, activation: 0, paid: 0 });
    expect(organic.rates.activationRate).toBe(0); // 0 activations / 4 signups
  });

  it("breaks the funnel down by agent, each row carrying its own counts + rates", () => {
    const view = aggregateFunnel(events);
    const mark = view.byAgent.find((r) => r.key === "mark")!;
    const scout = view.byAgent.find((r) => r.key === "scout")!;
    expect(mark.counts).toEqual({ visit: 80, signup: 16, activation: 8, paid: 2 });
    expect(scout.counts).toEqual({ visit: 20, signup: 4, activation: 0, paid: 0 });
  });

  it("orders breakdown rows by visit volume descending (highest-traffic first)", () => {
    const view = aggregateFunnel(events);
    expect(view.byChannel.map((r) => r.key)).toEqual(["producthunt", "organic"]);
    expect(view.byAgent.map((r) => r.key)).toEqual(["mark", "scout"]);
  });

  it("is an empty, all-zero view for no events", () => {
    const view = aggregateFunnel([]);
    expect(view.counts).toEqual({ visit: 0, signup: 0, activation: 0, paid: 0 });
    expect(view.byChannel).toEqual([]);
    expect(view.byAgent).toEqual([]);
    expect(view.eventCount).toBe(0);
  });
});
