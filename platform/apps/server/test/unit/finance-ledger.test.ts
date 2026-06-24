import { describe, it, expect } from "vitest";
import {
  postingFromRevenueEvent,
  postingFromUsageWindow,
  signedCents,
  periodKeyOf,
  recentPeriodKeys,
  addMonths,
  computeUnitEconomics,
  composeClosePack,
  runwayForecast,
  recommendMoneyDecision,
  type LedgerPosting,
  type LedgerEntry,
} from "../../src/finance/ledger.js";
import { ledgerEntriesToCsv, closePacksToCsv } from "../../src/finance/export.js";

const JAN = Date.parse("2026-01-15T00:00:00Z");
const FEB = Date.parse("2026-02-15T00:00:00Z");

describe("postings", () => {
  it("turns a Stripe revenue event into a verified credit", () => {
    const p = postingFromRevenueEvent("ws1", {
      providerEventId: "evt_1",
      amountCents: 4999,
      currency: "USD",
      createdAtMs: JAN,
    });
    expect(p).toMatchObject({
      direction: "credit",
      category: "revenue.stripe",
      amountCents: 4999,
      currency: "usd",
      verified: true,
      source: "stripe_event",
      sourceRef: "evt_1",
      ventureIdeaId: null,
    });
  });

  it("attributes a revenue event to a venture when provided", () => {
    const p = postingFromRevenueEvent("ws1", {
      providerEventId: "evt_2",
      amountCents: 100,
      currency: "usd",
      createdAtMs: JAN,
      ventureIdeaId: "v1",
    });
    expect(p.ventureIdeaId).toBe("v1");
  });

  it("turns a usage window into an UNVERIFIED debit keyed on the window", () => {
    const p = postingFromUsageWindow("ws1", "2026-01", 1234, JAN);
    expect(p).toMatchObject({
      direction: "debit",
      category: "cost.model",
      amountCents: 1234,
      verified: false,
      source: "tenant_usage",
      sourceRef: "2026-01",
    });
    expect(p.memo).toContain("UNVERIFIED");
  });

  it("never produces a negative amount", () => {
    expect(postingFromRevenueEvent("ws1", { providerEventId: "e", amountCents: -5, currency: "usd", createdAtMs: JAN }).amountCents).toBe(0);
    expect(postingFromUsageWindow("ws1", "2026-01", -9, JAN).amountCents).toBe(0);
  });

  it("signedCents signs by direction, never by the amount", () => {
    expect(signedCents({ direction: "credit", amountCents: 100 })).toBe(100);
    expect(signedCents({ direction: "debit", amountCents: 100 })).toBe(-100);
  });
});

describe("period bucketing", () => {
  it("buckets an instant into its UTC YYYY-MM", () => {
    expect(periodKeyOf(JAN)).toBe("2026-01");
    expect(periodKeyOf(Date.parse("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });

  it("recentPeriodKeys walks back oldest→newest and crosses a year boundary", () => {
    expect(recentPeriodKeys("2026-02", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(recentPeriodKeys("2026-02", 0)).toEqual([]);
  });

  it("addMonths advances and rolls over the year", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-01", 0)).toBe("2026-01");
  });
});

describe("unit economics", () => {
  it("computes CAC, LTV, margin, and the ratio when inputs exist", () => {
    const u = computeUnitEconomics({
      revenueCents: 10000,
      costCents: 4000,
      newCustomers: 4,
      activeCustomers: 10,
      avgLifetimeMonths: 3,
    });
    expect(u.cacCents).toBe(1000); // 4000 / 4
    expect(u.ltvCents).toBe(3000); // (10000/10) * 3
    expect(u.marginBps).toBe(6000); // 6000/10000
    expect(u.ltvToCacX100).toBe(300); // 3000/1000 = 3.0x
  });

  it("returns null (never fabricates) when counts are unknown", () => {
    const u = computeUnitEconomics({ revenueCents: 0, costCents: 500 });
    expect(u.cacCents).toBeNull();
    expect(u.ltvCents).toBeNull();
    expect(u.marginBps).toBeNull(); // no revenue
    expect(u.ltvToCacX100).toBeNull();
  });
});

describe("composeClosePack", () => {
  const entries: LedgerPosting[] = [
    postingFromRevenueEvent("ws1", { providerEventId: "e1", amountCents: 10000, currency: "usd", createdAtMs: JAN }),
    postingFromRevenueEvent("ws1", { providerEventId: "e2", amountCents: 5000, currency: "usd", createdAtMs: JAN }),
    postingFromUsageWindow("ws1", "2026-01", 4000, JAN),
  ];

  it("folds postings into revenue/cost/net with verified accounting", () => {
    const pack = composeClosePack({ workspaceId: "ws1", ventureIdeaId: null, periodKey: "2026-01", currency: "usd", entries });
    expect(pack.revenueCents).toBe(15000);
    expect(pack.costCents).toBe(4000);
    expect(pack.netCents).toBe(11000);
    expect(pack.verifiedRevenueCents).toBe(15000);
    expect(pack.verifiedCostCents).toBe(0); // model spend is UNVERIFIED
    expect(pack.entryCount).toBe(3);
  });

  it("reports verifiedShareBps as the externally-receipted share of total magnitude", () => {
    const pack = composeClosePack({ workspaceId: "ws1", ventureIdeaId: null, periodKey: "2026-01", currency: "usd", entries });
    // verified magnitude = 15000 (revenue); total = 19000 → 15000/19000 = 0.78947 → 7895 bps
    expect(pack.verifiedShareBps).toBe(7895);
  });

  it("an empty period closes to zeros with 0 verified share", () => {
    const pack = composeClosePack({ workspaceId: "ws1", ventureIdeaId: "v1", periodKey: "2026-03", currency: "usd", entries: [] });
    expect(pack).toMatchObject({ revenueCents: 0, costCents: 0, netCents: 0, verifiedShareBps: 0, entryCount: 0 });
  });
});

describe("runwayForecast", () => {
  it("predicts the breach period before it happens when burning", () => {
    const f = runwayForecast({
      workspaceId: "ws1",
      currency: "usd",
      cashPositionCents: 30000, // $300
      currentPeriodKey: "2026-02",
      periods: [
        { periodKey: "2025-12", netCents: -10000, verifiedNetCents: -2000 },
        { periodKey: "2026-01", netCents: -10000, verifiedNetCents: -2000 },
      ],
    });
    expect(f.monthlyNetCents).toBe(-10000);
    expect(f.monthlyBurnCents).toBe(10000);
    expect(f.runwayDays).toBe(90); // 30000/10000 * 30
    expect(f.monthsToBreach).toBe(3);
    expect(f.breachPeriodKey).toBe("2026-05"); // feb + 3
    expect(f.health).toBe("at_risk"); // within 3 months
    expect(f.verifiedMonthlyNetCents).toBe(-2000);
    expect(f.closedPeriodCount).toBe(2);
    expect(f.incompletePeriodCount).toBe(0);
  });

  it("averages burn over closed periods and flags an incomplete lookback", () => {
    const f = runwayForecast({
      workspaceId: "ws1",
      currency: "usd",
      cashPositionCents: 30000,
      currentPeriodKey: "2026-02",
      periods: [{ periodKey: "2026-01", netCents: -10000, verifiedNetCents: -5000 }],
      lookbackPeriodCount: 3,
      incompletePeriodKeys: ["2025-11", "2025-12"],
    });

    expect(f.monthlyNetCents).toBe(-10000);
    expect(f.monthlyBurnCents).toBe(10000);
    expect(f.runwayDays).toBe(90);
    expect(f.lookbackPeriodCount).toBe(3);
    expect(f.closedPeriodCount).toBe(1);
    expect(f.incompletePeriodCount).toBe(2);
    expect(f.incompletePeriodKeys).toEqual(["2025-11", "2025-12"]);
  });

  it("derives the lookback size from incomplete keys when not passed explicitly", () => {
    const f = runwayForecast({
      workspaceId: "ws1",
      currency: "usd",
      cashPositionCents: 30000,
      currentPeriodKey: "2026-02",
      periods: [{ periodKey: "2026-01", netCents: -10000, verifiedNetCents: -5000 }],
      incompletePeriodKeys: ["2025-11", "2025-12"],
    });

    expect(f.lookbackPeriodCount).toBe(3);
    expect(f.incompletePeriodCount).toBe(2);
  });

  it("is healthy and has no breach when not burning", () => {
    const f = runwayForecast({
      workspaceId: "ws1",
      currency: "usd",
      cashPositionCents: 50000,
      currentPeriodKey: "2026-02",
      periods: [{ periodKey: "2026-01", netCents: 8000, verifiedNetCents: 8000 }],
    });
    expect(f.monthlyBurnCents).toBe(0);
    expect(f.runwayDays).toBeNull();
    expect(f.breachPeriodKey).toBeNull();
    expect(f.health).toBe("healthy");
  });

  it("is breached when already at/below the floor", () => {
    const f = runwayForecast({
      workspaceId: "ws1",
      currency: "usd",
      cashPositionCents: 0,
      currentPeriodKey: "2026-02",
      periods: [{ periodKey: "2026-01", netCents: -5000, verifiedNetCents: -5000 }],
    });
    expect(f.health).toBe("breached");
  });
});

describe("recommendMoneyDecision", () => {
  const runway = { cashPositionCents: 30000, monthlyBurnCents: 10000, currency: "usd" };

  it("holds a spend that would push the balance below the floor", () => {
    const r = recommendMoneyDecision({ amountCents: 31000, currency: "usd", runway });
    expect(r.recommendation).toBe("hold");
    expect(r.balanceAfterCents).toBe(-1000);
  });

  it("cautions a spend that leaves thin runway", () => {
    const r = recommendMoneyDecision({ amountCents: 25000, currency: "usd", runway });
    // balance after = 5000; runway = 5000/10000*30 = 15d ≤ 30 → caution
    expect(r.recommendation).toBe("caution");
    expect(r.runwayDaysAfter).toBe(15);
  });

  it("approves a spend that leaves comfortable runway", () => {
    const r = recommendMoneyDecision({ amountCents: 1000, currency: "usd", runway });
    expect(r.recommendation).toBe("approve");
  });

  it("approves when there is no active burn", () => {
    const r = recommendMoneyDecision({
      amountCents: 5000,
      currency: "usd",
      runway: { cashPositionCents: 10000, monthlyBurnCents: 0, currency: "usd" },
    });
    expect(r.recommendation).toBe("approve");
    expect(r.runwayDaysAfter).toBeNull();
  });
});

describe("CSV export", () => {
  const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
    id: "row1",
    workspaceId: "ws1",
    ventureIdeaId: null,
    direction: "credit",
    category: "revenue.stripe",
    amountCents: 4999,
    currency: "usd",
    verified: true,
    source: "stripe_event",
    sourceRef: "evt_1",
    occurredAtMs: JAN,
    memo: null,
    createdAtMs: JAN,
    ...over,
  });

  it("renders a ledger statement with a header and decimal money", () => {
    const csv = ledgerEntriesToCsv([entry({})]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("id,occurred_at,venture_idea_id,direction,category,amount,currency,verified,source,source_ref,memo");
    expect(lines[1]).toContain("49.99");
    expect(lines[1]).toContain("revenue.stripe");
  });

  it("RFC-4180-quotes a memo containing a comma", () => {
    const csv = ledgerEntriesToCsv([entry({ memo: "infra, ad spend" })]);
    expect(csv).toContain('"infra, ad spend"');
  });

  it("sorts ledger entries newest economic event first", () => {
    const csv = ledgerEntriesToCsv([
      entry({ id: "old", occurredAtMs: JAN }),
      entry({ id: "new", occurredAtMs: FEB }),
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[1]).toContain("new");
    expect(lines[2]).toContain("old");
  });

  it("renders a close-pack statement with verified share and null unit economics", () => {
    const pack = composeClosePack({
      workspaceId: "ws1",
      ventureIdeaId: null,
      periodKey: "2026-01",
      currency: "usd",
      entries: [postingFromUsageWindow("ws1", "2026-01", 4000, JAN)],
    });
    const csv = closePacksToCsv([pack]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("verified_share_pct");
    expect(lines[1]).toContain("0.00"); // verified share = 0% (only UNVERIFIED cost)
    // cac/ltv columns are empty when unknown
    expect(lines[1]).toContain(",,"); // consecutive empty fields for null unit economics
  });
});
