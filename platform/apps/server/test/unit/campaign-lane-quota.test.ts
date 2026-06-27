import { describe, expect, it } from "vitest";
import { decideCampaignLaneQuota } from "../../src/billing/campaign-lane-quota.js";
import type { ActivePlan } from "../../src/billing/plan-service.js";

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

describe("campaign lane quota (#1290)", () => {
  it("allows current behavior for workspaces without an activated plan", async () => {
    const decision = await decideCampaignLaneQuota("ws-1", {
      activePlanForWorkspace: async () => null,
      countActiveCampaignLanes: async () => 999,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("blocks a starter workspace at its active campaign-lane cap", async () => {
    const decision = await decideCampaignLaneQuota("ws-1", {
      activePlanForWorkspace: async () => activePlan(),
      countActiveCampaignLanes: async () => 1,
    });
    expect(decision).toMatchObject({
      ok: false,
      code: 403,
      resource: "active_campaign_lanes",
      limit: 1,
      used: 1,
      planKey: "starter",
    });
    if (!decision.ok) expect(decision.error).toContain("Active campaign-lane limit reached");
  });

  it("allows pro workspaces below the campaign-lane cap", async () => {
    const decision = await decideCampaignLaneQuota("ws-1", {
      activePlanForWorkspace: async () => activePlan({ planKey: "pro", agentSeats: 10, fleetSize: 3 }),
      countActiveCampaignLanes: async () => 2,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("requires billing recovery for inactive plan rows", async () => {
    const decision = await decideCampaignLaneQuota("ws-1", {
      activePlanForWorkspace: async () => activePlan({ status: "canceled", renewalStatus: "expired" }),
      countActiveCampaignLanes: async () => 0,
    });
    expect(decision).toMatchObject({
      ok: false,
      code: 402,
      resource: "active_campaign_lanes",
      planKey: "starter",
    });
  });
});
