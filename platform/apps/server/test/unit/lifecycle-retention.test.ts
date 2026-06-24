import { describe, expect, it } from "vitest";
import { planLifecycleActions } from "../../src/lifecycle/retention.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-24T00:00:00Z");

describe("customer lifecycle retention planner (#914)", () => {
  it("raises dormancy, high-churn, renewal, and cancellation interventions without sending autonomously", () => {
    const actions = planLifecycleActions(
      [
        {
          workspaceId: "silent",
          planKey: "pro",
          renewalStatus: "active",
          lastActivityAtMs: NOW - 15 * DAY,
          nextBillingAtMs: NOW + 20 * DAY,
          highChurnSignals: 0,
        },
        {
          workspaceId: "angry",
          planKey: "pro",
          renewalStatus: "active",
          lastActivityAtMs: NOW - DAY,
          nextBillingAtMs: NOW + 2 * DAY,
          highChurnSignals: 2,
        },
        {
          workspaceId: "leaving",
          planKey: "starter",
          renewalStatus: "canceled",
          lastActivityAtMs: NOW - DAY,
          nextBillingAtMs: null,
          highChurnSignals: 0,
        },
      ],
      { dormancyDays: 14, renewalReminderDays: 7 },
      NOW,
    );

    expect(actions.map((a) => [a.workspaceId, a.kind, a.priority])).toEqual([
      ["angry", "high_churn_escalation", "high"],
      ["leaving", "cancellation_offer", "high"],
      ["silent", "dormancy_check", "medium"],
      ["angry", "renewal_reminder", "medium"],
    ]);
    expect(actions[0]!.reason).toContain("same-day owner follow-up");
  });
});
