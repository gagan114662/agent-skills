import { describe, expect, it } from "vitest";
import { buildJourneys } from "../../src/analytics/revenue/attribution.js";
import { buildDashboard, dayKeyUtc, MICROS_PER_CENT } from "../../src/analytics/revenue/dashboard.js";
import type { DailySpend } from "../../src/analytics/revenue/dashboard.js";
import type { Payment, PipelineEntry, Touch } from "../../src/analytics/revenue/types.js";

const DAY = 86_400_000;
const d1 = Date.parse("2026-06-20T08:00:00Z");
const d2 = Date.parse("2026-06-21T08:00:00Z");

const touches: Touch[] = [
  { customerRef: "ref-1", channel: "seo", agent: "scout", kind: "page", artifactId: "p1", occurredAtMs: d1 - 2 * DAY },
  { customerRef: "ref-1", channel: "social", agent: "mark", kind: "post", artifactId: "p2", occurredAtMs: d1 - DAY },
  { customerRef: "ref-2", channel: "ads", agent: "mark", kind: "ad", artifactId: "ad1", occurredAtMs: d2 - DAY },
];
const payments: Payment[] = [
  { customerRef: "ref-1", providerEventId: "e1", amountCents: 10_000, currency: "usd", paidAtMs: d1 },
  { customerRef: "ref-2", providerEventId: "e2", amountCents: 20_000, currency: "usd", paidAtMs: d2 },
  // A no-ref / unattributed paying customer — still counts toward revenue, no touch chain.
  { customerRef: "pe:e3", providerEventId: "e3", amountCents: 5_000, currency: "usd", paidAtMs: d2 },
];
const spend: DailySpend[] = [
  { date: dayKeyUtc(d1), micros: 1_000_000 }, // $1
  { date: dayKeyUtc(d2), micros: 2_000_000 }, // $2
];
const pipeline: PipelineEntry[] = [
  { ref: "pl-1", label: "pro", channel: "direct", agent: "none", estValueCents: 50_000, currency: "usd", stage: "link_minted", updatedAtMs: d2 },
];

function snapshot() {
  const journeys = buildJourneys(touches, payments, { model: "linear" });
  return buildDashboard(
    { journeys, payments, spend, pipeline, currency: "usd", model: "linear" },
    { sinceMs: d1 - 5 * DAY, untilMs: d2 + DAY, nowMs: d2 + DAY },
  );
}

describe("buildDashboard — the glanceable revenue/pipeline/spend view (#615)", () => {
  it("headlines revenue, paying customers, payment count, and AOV", () => {
    const t = snapshot().totals;
    expect(t.revenueCents).toBe(35_000);
    expect(t.payingCustomers).toBe(3);
    expect(t.paymentCount).toBe(3);
    expect(t.avgOrderValueCents).toBe(Math.round(35_000 / 3));
    expect(t.currency).toBe("usd");
  });

  it("sums spend and computes net + roi in micro-dollars", () => {
    const t = snapshot().totals;
    expect(t.spendMicros).toBe(3_000_000);
    expect(t.netMicros).toBe(35_000 * MICROS_PER_CENT - 3_000_000);
    expect(t.roi).toBeCloseTo((35_000 * MICROS_PER_CENT) / 3_000_000);
  });

  it("reports open pipeline value + count", () => {
    const t = snapshot().totals;
    expect(t.pipelineOpenCents).toBe(50_000);
    expect(t.pipelineOpenCount).toBe(1);
  });

  it("builds a per-UTC-day revenue + spend trend, ascending, with net", () => {
    const trend = snapshot().trend;
    expect(trend.map((p) => p.date)).toEqual([dayKeyUtc(d1), dayKeyUtc(d2)]);
    const day1 = trend[0];
    expect(day1.revenueCents).toBe(10_000);
    expect(day1.payingCustomers).toBe(1);
    expect(day1.spendMicros).toBe(1_000_000);
    expect(day1.netMicros).toBe(10_000 * MICROS_PER_CENT - 1_000_000);
    const day2 = trend[1];
    expect(day2.revenueCents).toBe(25_000); // ref-2 (20000) + unattributed (5000)
    expect(day2.payingCustomers).toBe(2);
  });

  it("surfaces multi-touch attribution by channel and agent", () => {
    const d = snapshot();
    // ref-1: 10000 linear → 5000 seo / 5000 social. ref-2: 20000 ads. unattributed: no credit.
    expect(d.byChannel.find((c) => c.key === "ads")).toMatchObject({ attributedCents: 20_000 });
    expect(d.byChannel.find((c) => c.key === "seo")).toMatchObject({ attributedCents: 5_000 });
    expect(d.byChannel.find((c) => c.key === "social")).toMatchObject({ attributedCents: 5_000 });
    expect(d.byAgent.find((a) => a.key === "mark")).toMatchObject({ attributedCents: 25_000 });
    expect(d.byAgent.find((a) => a.key === "scout")).toMatchObject({ attributedCents: 5_000 });
  });

  it("lists top journeys highest-revenue first and respects the cap", () => {
    const journeys = buildJourneys(touches, payments, { model: "linear" });
    const d = buildDashboard(
      { journeys, payments, spend, pipeline, currency: "usd", model: "linear" },
      { sinceMs: null, untilMs: d2 + DAY, nowMs: d2 + DAY, topJourneys: 2 },
    );
    expect(d.topJourneys).toHaveLength(2);
    expect(d.topJourneys[0].customerRef).toBe("ref-2"); // 20000 is the biggest
    expect(d.window.days).toBe(0); // full history
  });

  it("degrades honestly with no spend and no pipeline", () => {
    const journeys = buildJourneys(touches, payments, { model: "linear" });
    const t = buildDashboard(
      { journeys, payments, currency: "usd", model: "linear" },
      { sinceMs: null, untilMs: d2, nowMs: d2 },
    ).totals;
    expect(t.spendMicros).toBe(0);
    expect(t.roi).toBeNull();
    expect(t.pipelineOpenCents).toBe(0);
    expect(t.netMicros).toBe(35_000 * MICROS_PER_CENT);
  });
});
