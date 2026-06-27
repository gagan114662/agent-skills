import { describe, expect, it } from "vitest";
import { decideApprovalQueueQuota } from "../../src/billing/approval-queue-quota.js";
import type { ActivePlan } from "../../src/billing/plan-service.js";

const NOW = new Date("2026-06-27T12:00:00.000Z");

function plan(overrides: Partial<ActivePlan> = {}): ActivePlan {
  return {
    workspaceId: "w1",
    planKey: "starter",
    status: "active",
    renewalStatus: "active",
    agentSeats: 3,
    monthlySessionBudgetCents: 20_000,
    fleetSize: 1,
    providerEventId: null,
    expiresAt: new Date("2026-07-27T12:00:00.000Z"),
    nextBillingAt: new Date("2026-07-27T12:00:00.000Z"),
    retryCount: 0,
    retryScheduledAt: null,
    lastPaymentFailedAt: null,
    activatedAt: NOW,
    ...overrides,
  };
}

describe("approval queue plan quota (#1290)", () => {
  it("blocks the next pending approval when the active plan queue is full", () => {
    expect(
      decideApprovalQueueQuota({
        plan: plan({ planKey: "starter" }),
        pendingApprovals: 20,
        now: NOW,
      }),
    ).toMatchObject({
      ok: false,
      statusCode: 403,
      limit: 20,
      used: 20,
    });
  });

  it("allows larger plans to carry larger pending approval queues", () => {
    expect(
      decideApprovalQueueQuota({
        plan: plan({ planKey: "pro" }),
        pendingApprovals: 20,
        now: NOW,
      }),
    ).toMatchObject({ ok: true, limit: 75, used: 20 });
  });

  it("blocks expired plans before opening more pending approvals", () => {
    expect(
      decideApprovalQueueQuota({
        plan: plan({ expiresAt: new Date("2026-06-01T00:00:00.000Z") }),
        pendingApprovals: 0,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, statusCode: 402 });
  });
});
