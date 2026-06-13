import { describe, it, expect } from "vitest";
import {
  ageSeconds,
  clampWords,
  composeDailyBrief,
  composeDecisionQueue,
  composeWeeklyReport,
  escalationLevel,
  formatMoney,
  wordCount,
  type DailyBriefInput,
  type DecisionItem,
  type EscalationThresholds,
  type VentureKpiSnapshot,
} from "../../src/founder-briefings/aggregate.js";

const NOW = Date.parse("2026-06-12T00:00:00Z");
const HOUR = 3600_000;

const THRESHOLDS: EscalationThresholds = {
  level1Seconds: 24 * 3600,
  level2Seconds: 72 * 3600,
  level3Seconds: 168 * 3600,
};

describe("helpers", () => {
  it("ageSeconds clamps a future timestamp to 0", () => {
    expect(ageSeconds(NOW, NOW + HOUR)).toBe(0);
    expect(ageSeconds(NOW, NOW - HOUR)).toBe(3600);
  });

  it("formatMoney renders USD as $ and other currencies with the ISO code", () => {
    expect(formatMoney(1234, "usd")).toBe("$12.34");
    expect(formatMoney(1000, "eur")).toBe("EUR 10.00");
  });

  it("escalationLevel rises as age crosses each threshold", () => {
    expect(escalationLevel(0, THRESHOLDS)).toBe(0);
    expect(escalationLevel(24 * 3600, THRESHOLDS)).toBe(1);
    expect(escalationLevel(72 * 3600, THRESHOLDS)).toBe(2);
    expect(escalationLevel(168 * 3600, THRESHOLDS)).toBe(3);
    expect(escalationLevel(1000 * 3600, THRESHOLDS)).toBe(3);
  });

  it("clampWords guarantees the word budget", () => {
    const parts = Array.from({ length: 50 }, (_, i) => `sentence-${i} word word.`);
    const out = clampWords(parts, 10);
    expect(out.wordCount).toBeLessThanOrEqual(10);
    expect(wordCount(out.text)).toBeLessThanOrEqual(10);
    expect(out.text.endsWith("…")).toBe(true);
  });
});

describe("composeDecisionQueue", () => {
  function item(over: Partial<DecisionItem>): DecisionItem {
    return { kind: "approval", id: "a", title: "t", impact: "normal", createdAtMs: NOW, link: null, ...over };
  }

  it("orders by impact desc, then oldest-first", () => {
    const out = composeDecisionQueue({
      workspaceId: "ws",
      nowMs: NOW,
      thresholds: THRESHOLDS,
      items: [
        item({ id: "normal-new", impact: "normal", createdAtMs: NOW - 1 * HOUR }),
        item({ id: "high-new", impact: "high", createdAtMs: NOW - 1 * HOUR }),
        item({ id: "high-old", impact: "high", createdAtMs: NOW - 5 * HOUR }),
        item({ id: "critical", impact: "critical", createdAtMs: NOW - 1 * HOUR }),
      ],
    });
    expect(out.items.map((i) => i.id)).toEqual(["critical", "high-old", "high-new", "normal-new"]);
    expect(out.byImpact).toEqual({ critical: 1, high: 2, normal: 1 });
    expect(out.total).toBe(4);
  });

  it("computes age + escalation level per item and counts stale/critical", () => {
    const out = composeDecisionQueue({
      workspaceId: "ws",
      nowMs: NOW,
      thresholds: THRESHOLDS,
      items: [
        item({ id: "fresh", createdAtMs: NOW - 1 * HOUR }),
        item({ id: "stale", createdAtMs: NOW - 30 * HOUR }),
        item({ id: "critical", createdAtMs: NOW - 200 * HOUR }),
      ],
    });
    const byId = Object.fromEntries(out.items.map((i) => [i.id, i]));
    expect(byId.fresh!.escalationLevel).toBe(0);
    expect(byId.stale!.escalationLevel).toBe(1);
    expect(byId.critical!.escalationLevel).toBe(3);
    expect(out.stale).toBe(2); // stale + critical are both ≥ level 1
    expect(out.critical).toBe(1);
  });
});

describe("composeDailyBrief", () => {
  function input(over: Partial<DailyBriefInput> = {}): DailyBriefInput {
    return {
      workspaceId: "ws",
      nowMs: NOW,
      brandName: "ipop",
      shipped: [],
      blocked: [],
      decisionQueue: composeDecisionQueue({ workspaceId: "ws", nowMs: NOW, items: [], thresholds: THRESHOLDS }),
      spend: { window: "2026-06", estimatedCostCents: 0, budgetCents: 0, currency: "usd" },
      constitution: { open: 0, topCodes: [] },
      incidents: { open: 0, escalated: 0, resolved: 0, topVenture: null },
      maxWords: 200,
      ...over,
    };
  }

  it("renders a quiet brief under the word budget", () => {
    const out = composeDailyBrief(input());
    expect(out.wordCount).toBeLessThanOrEqual(200);
    expect(out.text).toContain("ipop daily brief");
    expect(out.text).toContain("Nothing shipped");
    expect(out.text).toContain("No decisions waiting");
  });

  it("computes overBudget + utilization", () => {
    const out = composeDailyBrief(
      input({ spend: { window: "2026-06", estimatedCostCents: 1500, budgetCents: 1000, currency: "usd" } }),
    );
    expect(out.spend.overBudget).toBe(true);
    expect(out.spend.utilization).toBeCloseTo(1.5);
    expect(out.text).toContain("over budget");
  });

  it("surfaces ships, blocks, decisions, and constitution flags", () => {
    const queue = composeDecisionQueue({
      workspaceId: "ws",
      nowMs: NOW,
      thresholds: THRESHOLDS,
      items: [{ kind: "approval", id: "a1", title: "Approve refund", impact: "high", createdAtMs: NOW - 200 * HOUR, link: "/x" }],
    });
    const out = composeDailyBrief(
      input({
        shipped: [{ title: "Ship A", ref: "pr-1" }],
        blocked: [{ title: "Block B", reason: "guardrail", ref: null }],
        decisionQueue: queue,
        constitution: { open: 2, topCodes: ["ART8_PRICING", "ART1_LOVE"] },
      }),
    );
    expect(out.decisionsWaiting).toHaveLength(1);
    expect(out.text).toContain("Shipped 1 item");
    expect(out.text).toContain("Blocked 1 item");
    expect(out.text).toContain("decision waiting on you");
    expect(out.text).toContain("1 critical"); // 200h old → level 3
    expect(out.text).toContain("constitution flag");
  });

  it("includes a self-healing ops incident summary when the fleet had incidents (#193 AC5)", () => {
    const out = composeDailyBrief(
      input({ incidents: { open: 1, escalated: 2, resolved: 3, topVenture: "shop.acme.com" } }),
    );
    expect(out.incidents.escalated).toBe(2);
    expect(out.text).toContain("6 ops incidents");
    expect(out.text).toContain("shop.acme.com");
    expect(out.text).toContain("3 auto-fixed");
    expect(out.text).toContain("2 escalated");
  });

  it("omits the incident line on a clean night", () => {
    const out = composeDailyBrief(input());
    expect(out.text).not.toContain("ops incident");
  });

  it("never exceeds the word budget even on a maxed-out input", () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ title: `${p}-${i}`, ref: null }));
    const out = composeDailyBrief(
      input({
        maxWords: 30,
        shipped: many(40, "ship"),
        blocked: many(40, "block").map((b) => ({ ...b, reason: "a very long blocking reason here" })),
        constitution: { open: 99, topCodes: Array.from({ length: 20 }, (_, i) => `CODE_${i}`) },
      }),
    );
    expect(out.wordCount).toBeLessThanOrEqual(30);
  });
});

describe("composeWeeklyReport", () => {
  function venture(over: Partial<VentureKpiSnapshot>): VentureKpiSnapshot {
    return {
      ideaId: "v1",
      status: "active",
      decision: null,
      currentScore: null,
      previousScore: null,
      revenueCents: null,
      costCents: null,
      ...over,
    };
  }

  it("derives net, margin, scoreDelta, and the P&L presence flag", () => {
    const out = composeWeeklyReport({
      workspaceId: "ws",
      nowMs: NOW,
      brandName: "ipop",
      currency: "usd",
      revenueTotalCents: 50_000,
      ventures: [
        venture({ ideaId: "profit", decision: "DOUBLE_DOWN", currentScore: 80, previousScore: 70, revenueCents: 10_000, costCents: 4_000 }),
        venture({ ideaId: "burn", decision: "SUNSET", currentScore: 30, previousScore: 45, revenueCents: 1_000, costCents: 6_000 }),
        venture({ ideaId: "unreviewed" }),
      ],
      voiceSignals: [{ summary: "Churn risk on pricing", sentiment: "negative", churnRisk: "high" }],
      backlog: [{ title: "Ship onboarding", score: 12, position: 1 }],
      maxWords: 400,
    });

    const byId = Object.fromEntries(out.ventures.map((v) => [v.ideaId, v]));
    expect(byId.profit!.netCents).toBe(6_000);
    expect(byId.profit!.marginPct).toBeCloseTo(60);
    expect(byId.profit!.scoreDelta).toBe(10);
    expect(byId.profit!.hasPnl).toBe(true);
    expect(byId.burn!.netCents).toBe(-5_000);
    expect(byId.burn!.scoreDelta).toBe(-15);
    expect(byId.unreviewed!.hasPnl).toBe(false);
    expect(byId.unreviewed!.netCents).toBeNull();
    expect(byId.unreviewed!.marginPct).toBeNull();

    expect(out.recommendations).toEqual({ doubleDown: 1, maintain: 0, pivot: 0, sunset: 1 });
    expect(out.revenueTotalCents).toBe(50_000);
    expect(out.wordCount).toBeLessThanOrEqual(400);
    expect(out.text).toContain("weekly founder report");
    expect(out.text).toContain("1 profitable, 1 burning");
    expect(out.text).toContain("sunset");
    expect(out.text).toContain("Ship onboarding");
  });

  it("renders a zero-venture report", () => {
    const out = composeWeeklyReport({
      workspaceId: "ws",
      nowMs: NOW,
      brandName: "ipop",
      currency: "usd",
      revenueTotalCents: 0,
      ventures: [],
      voiceSignals: [],
      backlog: [],
      maxWords: 400,
    });
    expect(out.ventures).toEqual([]);
    expect(out.text).toContain("Revenue $0.00 across 0 ventures");
  });
});
