import { describe, expect, it } from "vitest";
import type { ActivePlan } from "../../src/billing/plan-service.js";
import {
  dashboardHistoryCutoffForPlan,
  dashboardHistoryCutoffForWorkspace,
} from "../../src/billing/dashboard-history.js";

function activePlan(overrides: Partial<ActivePlan> = {}): ActivePlan {
  return {
    workspaceId: "ws-1",
    planKey: "starter",
    status: "active",
    renewalStatus: "active",
    agentSeats: 3,
    monthlySessionBudgetCents: 20_000,
    fleetSize: 1,
    providerEventId: "evt-1",
    expiresAt: new Date("2026-07-27T00:00:00.000Z"),
    nextBillingAt: new Date("2026-07-27T00:00:00.000Z"),
    retryCount: 0,
    retryScheduledAt: null,
    lastPaymentFailedAt: null,
    activatedAt: new Date("2026-06-27T00:00:00.000Z"),
    ...overrides,
  };
}

describe("dashboard history retention (#1290)", () => {
  const now = new Date("2026-06-27T12:00:00.000Z");

  it("uses the active plan's dashboardHistoryDays as the read cutoff", () => {
    expect(dashboardHistoryCutoffForPlan(activePlan(), now)?.toISOString()).toBe(
      "2026-06-13T12:00:00.000Z",
    );
    expect(
      dashboardHistoryCutoffForPlan(activePlan({ planKey: "pro", agentSeats: 10, fleetSize: 3 }), now)?.toISOString(),
    ).toBe("2026-03-29T12:00:00.000Z");
  });

  it("does not trim dashboard reads for workspaces without an active plan", async () => {
    await expect(
      dashboardHistoryCutoffForWorkspace(
        "ws-1",
        { activePlanForWorkspace: async () => null },
        now,
      ),
    ).resolves.toBeNull();
    expect(
      dashboardHistoryCutoffForPlan(activePlan({ status: "canceled", renewalStatus: "expired" }), now),
    ).toBeNull();
  });
});
