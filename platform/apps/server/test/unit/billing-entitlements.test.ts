import { describe, expect, it } from "vitest";
import { decidePlanQuota } from "../../src/billing/entitlements.js";
import type { ActivePlan } from "../../src/billing/plan-service.js";

const NOW = new Date("2026-06-25T12:00:00Z");

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
    expiresAt: new Date("2026-07-25T12:00:00Z"),
    nextBillingAt: new Date("2026-07-25T12:00:00Z"),
    retryCount: 0,
    retryScheduledAt: null,
    lastPaymentFailedAt: null,
    activatedAt: NOW,
    ...overrides,
  };
}

describe("plan quota entitlements (#877)", () => {
  it("blocks the N+1st Starter agent while allowing Pro and Agency caps", () => {
    expect(decidePlanQuota({ plan: plan({ planKey: "starter", agentSeats: 3 }), usage: { agents: 3, channels: 0 }, resource: "agent", now: NOW })).toMatchObject({ ok: false, statusCode: 403, limit: 3 });
    expect(decidePlanQuota({ plan: plan({ planKey: "pro", agentSeats: 10 }), usage: { agents: 9, channels: 0 }, resource: "agent", now: NOW })).toMatchObject({ ok: true });
    expect(decidePlanQuota({ plan: plan({ planKey: "agency", agentSeats: 30 }), usage: { agents: 29, channels: 0 }, resource: "agent", now: NOW })).toMatchObject({ ok: true });
  });

  it("blocks channel creation once the plan fleet-size cap is reached", () => {
    expect(decidePlanQuota({ plan: plan({ planKey: "starter", fleetSize: 1 }), usage: { agents: 0, channels: 1 }, resource: "channel", now: NOW })).toMatchObject({ ok: false, statusCode: 403, limit: 1 });
    expect(decidePlanQuota({ plan: plan({ planKey: "pro", fleetSize: 3 }), usage: { agents: 0, channels: 2 }, resource: "channel", now: NOW })).toMatchObject({ ok: true });
    expect(decidePlanQuota({ plan: plan({ planKey: "agency", fleetSize: 10 }), usage: { agents: 0, channels: 9 }, resource: "channel", now: NOW })).toMatchObject({ ok: true });
  });

  it("blocks expired, canceled, and downgraded plans according to the current row", () => {
    expect(decidePlanQuota({ plan: plan({ expiresAt: new Date("2026-06-01T00:00:00Z") }), usage: { agents: 0, channels: 0 }, resource: "agent", now: NOW })).toMatchObject({ ok: false, statusCode: 402 });
    expect(decidePlanQuota({ plan: plan({ status: "canceled", renewalStatus: "canceled" }), usage: { agents: 0, channels: 0 }, resource: "agent", now: NOW })).toMatchObject({ ok: false, statusCode: 402 });
    expect(decidePlanQuota({ plan: plan({ planKey: "starter", agentSeats: 3 }), usage: { agents: 3, channels: 0 }, resource: "agent", now: NOW })).toMatchObject({ ok: false, limit: 3 });
  });
});
