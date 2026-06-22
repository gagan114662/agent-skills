import { describe, expect, it } from "vitest";
import { RevenueAnalyticsService, type RevenueAnalyticsDeps } from "../../src/analytics/revenue/service.js";
import type { DailySpend } from "../../src/analytics/revenue/dashboard.js";
import type { Payment, PipelineEntry, Touch } from "../../src/analytics/revenue/types.js";

const WS = "ws-1";
const DAY = 86_400_000;
const NOW = Date.parse("2026-06-22T00:00:00Z");

/** In-memory fakes of the four reader seams — exercises the service with no DB, workspace-scoped. */
function makeDeps(over: {
  touches?: Touch[];
  payments?: Payment[];
  spend?: DailySpend[];
  pipeline?: PipelineEntry[];
  workspaceId?: string;
}): RevenueAnalyticsDeps {
  const ws = over.workspaceId ?? WS;
  const scoped = <T>(rows: T[], wid: string) => (wid === ws ? rows : []);
  return {
    touches: {
      listTouches: async (wid, sinceMs) =>
        scoped(over.touches ?? [], wid).filter((t) => sinceMs === undefined || t.occurredAtMs >= sinceMs),
    },
    revenue: {
      listPayments: async (wid, sinceMs) =>
        scoped(over.payments ?? [], wid).filter((p) => sinceMs === undefined || p.paidAtMs >= sinceMs),
    },
    spend: { dailySpendMicros: async (wid) => scoped(over.spend ?? [], wid) },
    pipeline: { listOpen: async (wid) => scoped(over.pipeline ?? [], wid) },
    currency: () => "usd",
    now: () => NOW,
  };
}

const touch = (p: Partial<Touch> & { customerRef: string; occurredAtMs: number }): Touch => ({
  channel: "seo",
  agent: "scout",
  kind: "page",
  artifactId: "p1",
  ...p,
});
const payment = (p: Partial<Payment> & { customerRef: string; paidAtMs: number }): Payment => ({
  providerEventId: `e-${p.customerRef}`,
  amountCents: 10_000,
  currency: "usd",
  ...p,
});

describe("RevenueAnalyticsService.customerJourney (#614 acceptance)", () => {
  it("returns one paying customer's end-to-end multi-touch journey", async () => {
    const svc = new RevenueAnalyticsService(
      makeDeps({
        touches: [
          touch({ customerRef: "ref-1", channel: "seo", agent: "scout", occurredAtMs: NOW - 10 * DAY }),
          touch({ customerRef: "ref-1", channel: "email", agent: "mark", occurredAtMs: NOW - 5 * DAY }),
          touch({ customerRef: "ref-2", channel: "ads", agent: "mark", occurredAtMs: NOW - 3 * DAY }),
        ],
        payments: [payment({ customerRef: "ref-1", paidAtMs: NOW - DAY, amountCents: 8_000 })],
      }),
    );
    const j = await svc.customerJourney(WS, "ref-1", "linear");
    expect(j).not.toBeNull();
    expect(j!.channels).toEqual(["seo", "email"]);
    expect(j!.agents).toEqual(["scout", "mark"]);
    expect(j!.credits.reduce((a, c) => a + c.creditCents, 0)).toBe(8_000);
  });

  it("returns null for a tracking ref that never paid", async () => {
    const svc = new RevenueAnalyticsService(
      makeDeps({ touches: [touch({ customerRef: "ref-3", occurredAtMs: NOW - DAY })], payments: [] }),
    );
    expect(await svc.customerJourney(WS, "ref-3")).toBeNull();
  });
});

describe("RevenueAnalyticsService.journeys", () => {
  it("picks up a touch from BEFORE the revenue window via the chain-age lookback", async () => {
    const svc = new RevenueAnalyticsService(
      makeDeps({
        // touch 20 days ago, payment 2 days ago, default revenue window 30d but the touch lookback is wider.
        touches: [touch({ customerRef: "ref-1", channel: "seo", occurredAtMs: NOW - 20 * DAY })],
        payments: [payment({ customerRef: "ref-1", paidAtMs: NOW - 2 * DAY })],
      }),
    );
    const journeys = await svc.journeys(WS, { windowDays: 7, model: "linear" });
    expect(journeys).toHaveLength(1);
    expect(journeys[0].touchCount).toBe(1); // the pre-window touch still attributed
  });
});

describe("RevenueAnalyticsService.dashboard (#615)", () => {
  it("assembles totals from the seams, scoped to the workspace", async () => {
    const svc = new RevenueAnalyticsService(
      makeDeps({
        touches: [touch({ customerRef: "ref-1", channel: "seo", occurredAtMs: NOW - 4 * DAY })],
        payments: [payment({ customerRef: "ref-1", paidAtMs: NOW - DAY, amountCents: 12_000 })],
        spend: [{ date: "2026-06-21", micros: 500_000 }],
        pipeline: [{ ref: "pl-1", label: "pro", channel: "direct", agent: "none", estValueCents: 30_000, currency: "usd", stage: "link_minted", updatedAtMs: NOW }],
      }),
    );
    const d = await svc.dashboard(WS, { windowDays: 30 });
    expect(d.totals.revenueCents).toBe(12_000);
    expect(d.totals.payingCustomers).toBe(1);
    expect(d.totals.spendMicros).toBe(500_000);
    expect(d.totals.pipelineOpenCents).toBe(30_000);
    expect(d.byChannel[0]).toMatchObject({ key: "seo", attributedCents: 12_000 });
  });

  it("never leaks another workspace's data (#3 IDOR)", async () => {
    const svc = new RevenueAnalyticsService(
      makeDeps({
        payments: [payment({ customerRef: "ref-1", paidAtMs: NOW - DAY })],
        workspaceId: "ws-1",
      }),
    );
    const d = await svc.dashboard("ws-OTHER", { windowDays: 30 });
    expect(d.totals.revenueCents).toBe(0);
    expect(d.totals.paymentCount).toBe(0);
  });
});
