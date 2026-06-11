import { describe, it, expect } from "vitest";
import {
  aggregateFounderConsole,
  type FounderConsoleInput,
} from "../../src/founder-console/aggregate.js";

const NOW = Date.parse("2026-06-10T00:00:00Z");

function input(over: Partial<FounderConsoleInput> = {}): FounderConsoleInput {
  return {
    workspaceId: "ws-1",
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

describe("aggregateFounderConsole — reliability insights pane (#148)", () => {
  it("zeroes the reliability pane when no insights are supplied (loop off / unwired)", () => {
    const out = aggregateFounderConsole(input());
    expect(out.reliability).toEqual({
      mttrMs: null,
      incidentsLast7d: 0,
      incidentsLast30d: 0,
      openCount: 0,
      total: 0,
      noisiestComponents: [],
    });
  });

  it("echoes the supplied reliability insights into the console", () => {
    const out = aggregateFounderConsole(
      input({
        reliability: {
          mttrMs: 1_800_000,
          incidentsLast7d: 2,
          incidentsLast30d: 5,
          openCount: 1,
          total: 9,
          noisiestComponents: [{ service: "api", count: 4 }],
        },
      }),
    );
    expect(out.reliability.mttrMs).toBe(1_800_000);
    expect(out.reliability.openCount).toBe(1);
    expect(out.reliability.noisiestComponents).toEqual([{ service: "api", count: 4 }]);
  });
});
