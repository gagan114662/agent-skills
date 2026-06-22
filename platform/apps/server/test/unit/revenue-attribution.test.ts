import { describe, expect, it } from "vitest";
import {
  buildJourney,
  buildJourneys,
  distributeCents,
  rollupByAgent,
  rollupByChannel,
  weightsFor,
} from "../../src/analytics/revenue/attribution.js";
import type { Payment, Touch } from "../../src/analytics/revenue/types.js";

const touch = (partial: Partial<Touch> & { customerRef: string; occurredAtMs: number }): Touch => ({
  channel: "direct",
  agent: "none",
  kind: "page",
  artifactId: "a",
  ...partial,
});

const payment = (partial: Partial<Payment> & { customerRef: string; paidAtMs: number }): Payment => ({
  providerEventId: `evt-${partial.customerRef}-${partial.paidAtMs}`,
  amountCents: 10_000,
  currency: "usd",
  ...partial,
});

describe("weightsFor", () => {
  it("collapses every model to [1] for a single touch", () => {
    for (const m of ["first_touch", "last_touch", "linear", "position_based"] as const) {
      expect(weightsFor(m, 1)).toEqual([1]);
    }
  });

  it("first/last put all weight on the right end", () => {
    expect(weightsFor("first_touch", 3)).toEqual([1, 0, 0]);
    expect(weightsFor("last_touch", 3)).toEqual([0, 0, 1]);
  });

  it("linear splits evenly", () => {
    const w = weightsFor("linear", 4);
    expect(w).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("position_based is U-shaped (40/20/40) and sums to 1", () => {
    const w = weightsFor("position_based", 4);
    expect(w[0]).toBeCloseTo(0.4);
    expect(w[3]).toBeCloseTo(0.4);
    expect(w[1]).toBeCloseTo(0.1);
    expect(w[2]).toBeCloseTo(0.1);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // n === 2 degenerates to an even split.
    expect(weightsFor("position_based", 2)).toEqual([0.5, 0.5]);
  });
});

describe("distributeCents", () => {
  it("splits exactly with no cent lost (largest-remainder)", () => {
    const out = distributeCents(10_000, weightsFor("linear", 3));
    expect(out.reduce((a, b) => a + b, 0)).toBe(10_000);
    // 10000/3 = 3333.33 → 3334, 3333, 3333 (remainder to the largest fractional parts).
    expect(out).toEqual([3334, 3333, 3333]);
  });

  it("handles a single weight and an empty list", () => {
    expect(distributeCents(999, [1])).toEqual([999]);
    expect(distributeCents(999, [])).toEqual([]);
  });
});

describe("buildJourney — multi-touch credit across the full chain (#614)", () => {
  const touches: Touch[] = [
    touch({ customerRef: "ref-1", channel: "seo", agent: "scout", artifactId: "p1", occurredAtMs: 1_000 }),
    touch({ customerRef: "ref-1", channel: "social", agent: "mark", artifactId: "p2", occurredAtMs: 2_000 }),
    touch({ customerRef: "ref-1", channel: "email", agent: "mark", artifactId: "p3", occurredAtMs: 3_000 }),
  ];

  it("orders touches earliest→latest and splits revenue linearly across all of them", () => {
    const j = buildJourney("ref-1", touches, [payment({ customerRef: "ref-1", paidAtMs: 5_000, amountCents: 9_000 })], {
      model: "linear",
    });
    expect(j.touchCount).toBe(3);
    expect(j.channels).toEqual(["seo", "social", "email"]);
    expect(j.agents).toEqual(["scout", "mark"]);
    expect(j.credits.map((c) => c.creditCents)).toEqual([3_000, 3_000, 3_000]);
    expect(j.credits.reduce((a, c) => a + c.creditCents, 0)).toBe(9_000);
    expect(j.totalPaidCents).toBe(9_000);
  });

  it("first_touch credits acquisition, last_touch credits the closer", () => {
    const first = buildJourney("ref-1", touches, [payment({ customerRef: "ref-1", paidAtMs: 5_000 })], { model: "first_touch" });
    expect(first.credits[0]).toMatchObject({ channel: "seo", creditCents: 10_000 });
    expect(first.credits[2].creditCents).toBe(0);

    const last = buildJourney("ref-1", touches, [payment({ customerRef: "ref-1", paidAtMs: 5_000 })], { model: "last_touch" });
    expect(last.credits[2]).toMatchObject({ channel: "email", creditCents: 10_000 });
    expect(last.credits[0].creditCents).toBe(0);
  });

  it("excludes touches that happened AFTER the payment (no backward causality)", () => {
    const withLate = [...touches, touch({ customerRef: "ref-1", channel: "ads", artifactId: "late", occurredAtMs: 9_000 })];
    const j = buildJourney("ref-1", withLate, [payment({ customerRef: "ref-1", paidAtMs: 5_000 })], { model: "linear" });
    expect(j.touchCount).toBe(3);
    expect(j.channels).not.toContain("ads");
  });

  it("drops touches older than maxChainAgeMs before the payment", () => {
    const j = buildJourney("ref-1", touches, [payment({ customerRef: "ref-1", paidAtMs: 5_000 })], {
      model: "linear",
      maxChainAgeMs: 2_500, // only touches within 2500ms of the 5000ms payment survive
    });
    // 5000-3000=2000 ok; 5000-2000=3000 too old; 5000-1000=4000 too old.
    expect(j.touches.map((t) => t.occurredAtMs)).toEqual([3_000]);
  });

  it("a paying customer with no matched touch is an honest empty journey (revenue, no attribution)", () => {
    const j = buildJourney("ref-x", [], [payment({ customerRef: "ref-x", paidAtMs: 1, amountCents: 4_200 })], { model: "linear" });
    expect(j.touchCount).toBe(0);
    expect(j.credits).toEqual([]);
    expect(j.totalPaidCents).toBe(4_200);
    expect(j.firstTouchAtMs).toBeNull();
  });

  it("sums multiple payments and anchors causality on the earliest one", () => {
    const j = buildJourney(
      "ref-1",
      touches,
      [payment({ customerRef: "ref-1", paidAtMs: 5_000, amountCents: 3_000 }), payment({ customerRef: "ref-1", paidAtMs: 9_000, amountCents: 6_000 })],
      { model: "linear" },
    );
    expect(j.paymentCount).toBe(2);
    expect(j.totalPaidCents).toBe(9_000);
    expect(j.paidAtMs).toBe(5_000);
  });
});

describe("buildJourneys + rollups", () => {
  const touches: Touch[] = [
    touch({ customerRef: "ref-1", channel: "seo", agent: "scout", artifactId: "p1", occurredAtMs: 1_000 }),
    touch({ customerRef: "ref-1", channel: "social", agent: "mark", artifactId: "p2", occurredAtMs: 2_000 }),
    touch({ customerRef: "ref-2", channel: "seo", agent: "scout", artifactId: "p1", occurredAtMs: 1_500 }),
  ];
  const payments: Payment[] = [
    payment({ customerRef: "ref-1", paidAtMs: 5_000, amountCents: 10_000 }),
    payment({ customerRef: "ref-2", paidAtMs: 6_000, amountCents: 20_000 }),
  ];

  it("builds one journey per paying customer, highest revenue first", () => {
    const journeys = buildJourneys(touches, payments, { model: "linear" });
    expect(journeys.map((j) => j.customerRef)).toEqual(["ref-2", "ref-1"]);
  });

  it("ignores touch-only customers (no payment ⇒ no journey)", () => {
    const journeys = buildJourneys(
      [...touches, touch({ customerRef: "ref-3", channel: "ads", occurredAtMs: 100 })],
      payments,
      { model: "linear" },
    );
    expect(journeys.find((j) => j.customerRef === "ref-3")).toBeUndefined();
  });

  it("rolls multi-touch credit up by channel and by agent", () => {
    const journeys = buildJourneys(touches, payments, { model: "linear" });
    // ref-1: 10000 split 5000 seo / 5000 social. ref-2: 20000 all seo (one touch).
    const byChannel = rollupByChannel(journeys);
    expect(byChannel.find((d) => d.key === "seo")).toMatchObject({ attributedCents: 25_000, customerCount: 2 });
    expect(byChannel.find((d) => d.key === "social")).toMatchObject({ attributedCents: 5_000, customerCount: 1 });

    const byAgent = rollupByAgent(journeys);
    expect(byAgent.find((d) => d.key === "scout")).toMatchObject({ attributedCents: 25_000 });
    expect(byAgent.find((d) => d.key === "mark")).toMatchObject({ attributedCents: 5_000 });
    // Total attributed equals total paid — no dollar lost or invented.
    expect(byChannel.reduce((a, d) => a + d.attributedCents, 0)).toBe(30_000);
  });
});
