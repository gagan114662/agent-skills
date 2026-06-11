import { describe, it, expect } from "vitest";
import {
  aggregateFounderConsole,
  type FounderConsoleInput,
} from "../../src/founder-console/aggregate.js";

const NOW = Date.parse("2026-06-10T00:00:00Z");

/** A quiet, nothing-pending baseline — every "attention" trigger off; override per case. */
function input(over: Partial<FounderConsoleInput> = {}): FounderConsoleInput {
  return {
    workspaceId: "ws-1",
    nowMs: NOW,
    fleet: { tenantInFlight: 0, globalInFlight: 0, sessionsThisWindow: 0 },
    ventures: [],
    revenue: { currency: "usd", totalCents: 0, paymentCount: 0, evidenceCount: 0 },
    budget: {
      window: "2026-06",
      estimatedCostCents: 0,
      budgetCents: 0,
      computeSeconds: 0,
      sessionsStarted: 0,
    },
    approvals: [],
    switches: { killSwitch: false, maintenance: { enabled: false } },
    gateBoundaries: { owned: [], history: [] },
    usageTrend: [],
    forecastWindow: "2026-07",
    infraBudgetCeilingCents: 0,
    tenantConcurrency: 0,
    ...over,
  };
}

describe("aggregateFounderConsole (the pure founder-console roll-up)", () => {
  it("echoes the workspace + clock instant and the fleet snapshot", () => {
    const out = aggregateFounderConsole(
      input({ fleet: { tenantInFlight: 3, globalInFlight: 7, sessionsThisWindow: 12 } }),
    );
    expect(out.workspaceId).toBe("ws-1");
    expect(out.generatedAtMs).toBe(NOW);
    expect(out.fleet).toEqual({ activeSessions: 3, sessionsThisWindow: 12, globalInFlight: 7 });
  });

  it("rolls up the venture pipeline by status + terminal verdict", () => {
    const out = aggregateFounderConsole(
      input({
        ventures: [
          { ideaId: "a", status: "active", terminalVerdict: null, lastScore: 55 },
          { ideaId: "b", status: "terminal", terminalVerdict: "FUND", lastScore: 82 },
          { ideaId: "c", status: "terminal", terminalVerdict: "KILL", lastScore: 12 },
          { ideaId: "d", status: "terminal", terminalVerdict: "ESCALATE", lastScore: 64 },
          { ideaId: "e", status: "terminal", terminalVerdict: "ESCALATE", lastScore: 66 },
        ],
      }),
    );
    expect(out.venturePipeline).toEqual({
      total: 5,
      active: 1,
      funded: 1,
      killed: 1,
      escalated: 2,
    });
  });

  it("surfaces willingness-to-pay evidence as the fundability signal", () => {
    const none = aggregateFounderConsole(input());
    expect(none.revenue.willingnessToPayCount).toBe(0);
    expect(none.revenue.hasWillingnessToPay).toBe(false);

    const paid = aggregateFounderConsole(
      input({ revenue: { currency: "usd", totalCents: 4200, paymentCount: 2, evidenceCount: 2 } }),
    );
    expect(paid.revenue.totalCents).toBe(4200);
    expect(paid.revenue.paymentCount).toBe(2);
    expect(paid.revenue.willingnessToPayCount).toBe(2);
    expect(paid.revenue.hasWillingnessToPay).toBe(true);
  });

  it("computes budget utilization + over-budget against the cap", () => {
    const under = aggregateFounderConsole(
      input({
        budget: {
          window: "2026-06",
          estimatedCostCents: 5000,
          budgetCents: 10000,
          computeSeconds: 30,
          sessionsStarted: 4,
        },
      }),
    );
    expect(under.budget.utilization).toBe(0.5);
    expect(under.budget.overBudget).toBe(false);

    const over = aggregateFounderConsole(
      input({
        budget: {
          window: "2026-06",
          estimatedCostCents: 10000,
          budgetCents: 10000,
          computeSeconds: 60,
          sessionsStarted: 9,
        },
      }),
    );
    expect(over.budget.overBudget).toBe(true); // >= cap
    expect(over.budget.utilization).toBe(1);
  });

  it("reports null utilization when no positive budget cap is set", () => {
    const out = aggregateFounderConsole(
      input({
        budget: {
          window: "2026-06",
          estimatedCostCents: 999,
          budgetCents: 0,
          computeSeconds: 5,
          sessionsStarted: 1,
        },
      }),
    );
    expect(out.budget.utilization).toBeNull();
    expect(out.budget.overBudget).toBe(false); // a 0 cap never bites
  });

  it("ages each pending approval and returns the queue oldest-first (the decision SLA)", () => {
    const out = aggregateFounderConsole(
      input({
        approvals: [
          { id: "new", actionType: "external.send", summary: "post tweet", amount: null, createdAtMs: NOW - 30_000 },
          { id: "old", actionType: "money.payout", summary: "refund $5", amount: 500, createdAtMs: NOW - 3_600_000 },
          { id: "mid", actionType: "autonomy.complete", summary: "ship PR", amount: null, createdAtMs: NOW - 120_000 },
        ],
      }),
    );
    expect(out.pendingApprovals.map((a) => a.id)).toEqual(["old", "mid", "new"]);
    expect(out.pendingApprovals[0]).toMatchObject({
      id: "old",
      actionType: "money.payout",
      amount: 500,
      ageSeconds: 3600,
    });
    expect(out.pendingApprovals[2].ageSeconds).toBe(30);
  });

  it("clamps a future-dated approval age to zero (never negative)", () => {
    const out = aggregateFounderConsole(
      input({
        approvals: [
          { id: "future", actionType: "x", summary: "s", amount: null, createdAtMs: NOW + 10_000 },
        ],
      }),
    );
    expect(out.pendingApprovals[0].ageSeconds).toBe(0);
  });

  it("passes the safety switches through read-only", () => {
    const out = aggregateFounderConsole(
      input({
        switches: {
          killSwitch: true,
          maintenance: { enabled: true, since: "2026-06-09T00:00:00Z", reason: "drill" },
        },
      }),
    );
    expect(out.switches.killSwitch).toBe(true);
    expect(out.switches.maintenance).toEqual({
      enabled: true,
      since: "2026-06-09T00:00:00Z",
      reason: "drill",
    });
  });

  it("requires no attention when nothing is pending and all switches are off", () => {
    const out = aggregateFounderConsole(input());
    expect(out.attention).toEqual({ required: false, reasons: [] });
  });

  it("lists every attention reason in priority order", () => {
    const out = aggregateFounderConsole(
      input({
        switches: { killSwitch: true, maintenance: { enabled: true } },
        budget: {
          window: "2026-06",
          estimatedCostCents: 10000,
          budgetCents: 10000,
          computeSeconds: 60,
          sessionsStarted: 9,
        },
        approvals: [
          { id: "a", actionType: "x", summary: "s", amount: null, createdAtMs: NOW - 1000 },
          { id: "b", actionType: "y", summary: "t", amount: null, createdAtMs: NOW - 2000 },
        ],
      }),
    );
    expect(out.attention.required).toBe(true);
    expect(out.attention.reasons).toEqual([
      "kill switch engaged",
      "maintenance mode active",
      "over budget",
      "2 pending approvals",
    ]);
  });

  it("surfaces the #119 autonomy boundaries: classes agents own + the change history", () => {
    const out = aggregateFounderConsole(
      input({
        gateBoundaries: {
          owned: [
            { actionType: "chat.post_message", errorRate: 0.02, windowSize: 100, sinceMs: NOW - 60_000 },
          ],
          history: [
            { actionType: "chat.post_message", direction: "RELAX", errorRate: 0.02, windowSize: 100, atMs: NOW - 60_000, reason: "earned" },
            { actionType: "draft.tweet", direction: "RETIGHTEN", errorRate: 0.2, windowSize: 100, atMs: NOW - 30_000, reason: "regressed" },
          ],
        },
      }),
    );
    expect(out.autonomyBoundaries.owned).toEqual([
      { actionType: "chat.post_message", errorRate: 0.02, windowSize: 100, sinceMs: NOW - 60_000 },
    ]);
    expect(out.autonomyBoundaries.history).toHaveLength(2);
    expect(out.autonomyBoundaries.history[0]).toMatchObject({
      actionType: "chat.post_message",
      direction: "RELAX",
      errorRate: 0.02,
    });
  });

  it("has empty autonomy boundaries by default (no class auto-relaxed yet)", () => {
    const out = aggregateFounderConsole(input());
    expect(out.autonomyBoundaries).toEqual({ owned: [], history: [] });
  });

  it("surfaces a cost forecast projected from the usage trend (#113)", () => {
    const out = aggregateFounderConsole(
      input({
        forecastWindow: "2026-07",
        usageTrend: [
          { window: "2026-04", computeSeconds: 600, estimatedCostCents: 1000, sessionsStarted: 4 },
          { window: "2026-05", computeSeconds: 900, estimatedCostCents: 1500, sessionsStarted: 6 },
          { window: "2026-06", computeSeconds: 1200, estimatedCostCents: 2000, sessionsStarted: 8 },
        ],
      }),
    );
    expect(out.costForecast.window).toBe("2026-07");
    expect(out.costForecast.basis).toBe("trend");
    expect(out.costForecast.projectedCostCents).toBe(2500);
  });

  it("recommends right-sizing from live tenant utilization (#113)", () => {
    const up = aggregateFounderConsole(
      input({ fleet: { tenantInFlight: 9, globalInFlight: 9, sessionsThisWindow: 0 }, tenantConcurrency: 10 }),
    );
    expect(up.costForecast.rightSizing.recommendation).toBe("scale_up");

    const down = aggregateFounderConsole(
      input({ fleet: { tenantInFlight: 1, globalInFlight: 1, sessionsThisWindow: 0 }, tenantConcurrency: 10 }),
    );
    expect(down.costForecast.rightSizing.recommendation).toBe("scale_down");
  });

  it("flags an infra-budget-ceiling breach and raises it to attention (#113, #108)", () => {
    const out = aggregateFounderConsole(
      input({
        forecastWindow: "2026-07",
        infraBudgetCeilingCents: 1500,
        usageTrend: [
          { window: "2026-05", computeSeconds: 900, estimatedCostCents: 1500, sessionsStarted: 6 },
          { window: "2026-06", computeSeconds: 1200, estimatedCostCents: 2000, sessionsStarted: 8 },
        ],
      }),
    );
    expect(out.costForecast.infraBudget.exceeded).toBe(true);
    expect(out.attention.required).toBe(true);
    expect(out.attention.reasons).toContain("infra budget ceiling projected breach");
  });

  it("does not warn on infra budget when no ceiling is set", () => {
    const out = aggregateFounderConsole(
      input({
        usageTrend: [
          { window: "2026-06", computeSeconds: 1200, estimatedCostCents: 9_999_999, sessionsStarted: 8 },
        ],
      }),
    );
    expect(out.costForecast.infraBudget.exceeded).toBe(false);
    expect(out.attention.reasons).not.toContain("infra budget ceiling projected breach");
  });

  it("singularizes the pending-approval reason for exactly one item", () => {
    const out = aggregateFounderConsole(
      input({
        approvals: [{ id: "a", actionType: "x", summary: "s", amount: null, createdAtMs: NOW - 1000 }],
      }),
    );
    expect(out.attention.reasons).toEqual(["1 pending approval"]);
  });
});
