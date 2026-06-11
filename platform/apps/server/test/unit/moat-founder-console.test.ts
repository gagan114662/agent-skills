import { describe, it, expect } from "vitest";
import {
  aggregateFounderConsole,
  type FounderConsoleInput,
} from "../../src/founder-console/aggregate.js";

const NOW = 1_000_000_000_000;

/** A minimal quiet console input — everything empty/off — that we layer moat onto. */
function baseInput(over: Partial<FounderConsoleInput> = {}): FounderConsoleInput {
  return {
    workspaceId: "ws1",
    nowMs: NOW,
    fleet: { tenantInFlight: 0, globalInFlight: 0, sessionsThisWindow: 0 },
    ventures: [],
    revenue: { currency: "usd", totalCents: 0, paymentCount: 0, evidenceCount: 0 },
    budget: { window: "2026-06", estimatedCostCents: 0, budgetCents: 0, computeSeconds: 0, sessionsStarted: 0 },
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

describe("founder console — moat view", () => {
  it("renders a zeroed moat view when moat is unwired", () => {
    const c = aggregateFounderConsole(baseInput());
    expect(c.moat).toEqual({
      enabled: false,
      windowDays: 30,
      tracked: 0,
      flaggedStagnant: 0,
      flagged: [],
    });
    expect(c.attention.reasons).not.toContain(
      "1 venture with stagnant moat (no accrual in 30d)",
    );
  });

  it("counts tracked ventures and lists the stagnant ones", () => {
    const c = aggregateFounderConsole(
      baseInput({
        moatEnabled: true,
        moatWindowDays: 30,
        moat: [
          { ventureIdeaId: "alive", score: 60, stagnant: false, accrualsInWindow: 3, lastAccrualAtMs: NOW },
          { ventureIdeaId: "dormant", score: 20, stagnant: true, accrualsInWindow: 0, lastAccrualAtMs: null },
        ],
      }),
    );
    expect(c.moat.tracked).toBe(2);
    expect(c.moat.flaggedStagnant).toBe(1);
    expect(c.moat.flagged.map((m) => m.ventureIdeaId)).toEqual(["dormant"]);
  });

  it("raises an attention reason when enabled and a venture is stagnant", () => {
    const c = aggregateFounderConsole(
      baseInput({
        moatEnabled: true,
        moatWindowDays: 14,
        moat: [
          { ventureIdeaId: "a", score: 0, stagnant: true, accrualsInWindow: 0, lastAccrualAtMs: null },
          { ventureIdeaId: "b", score: 0, stagnant: true, accrualsInWindow: 0, lastAccrualAtMs: null },
        ],
      }),
    );
    expect(c.attention.required).toBe(true);
    expect(c.attention.reasons).toContain("2 ventures with stagnant moat (no accrual in 14d)");
  });

  it("does NOT raise an attention reason when moat flagging is disabled", () => {
    const c = aggregateFounderConsole(
      baseInput({
        moatEnabled: false,
        moat: [
          { ventureIdeaId: "a", score: 0, stagnant: true, accrualsInWindow: 0, lastAccrualAtMs: null },
        ],
      }),
    );
    expect(c.moat.flaggedStagnant).toBe(1); // still reported informationally
    expect(c.attention.required).toBe(false);
    expect(c.attention.reasons).toEqual([]);
  });
});
