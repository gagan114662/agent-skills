export interface LifecyclePlanSnapshot {
  workspaceId: string;
  planKey: string | null;
  renewalStatus: "active" | "past_due" | "expired" | "canceled" | string;
  lastActivityAtMs: number | null;
  nextBillingAtMs: number | null;
  highChurnSignals: number;
}

export interface LifecyclePolicy {
  dormancyDays: number;
  renewalReminderDays: number;
}

export type LifecycleActionKind =
  | "dormancy_check"
  | "high_churn_escalation"
  | "renewal_reminder"
  | "cancellation_offer";

export interface LifecycleAction {
  kind: LifecycleActionKind;
  workspaceId: string;
  planKey: string | null;
  priority: "low" | "medium" | "high";
  reason: string;
  dueAtMs: number;
}

const DAY_MS = 86_400_000;

/**
 * Pure customer-lifecycle planner (#914). It turns existing facts (activity, churn signals, renewal state)
 * into explicit intervention work without sending anything by itself. The caller owns the delivery channel.
 */
export function planLifecycleActions(
  snapshots: LifecyclePlanSnapshot[],
  policy: LifecyclePolicy,
  nowMs: number,
): LifecycleAction[] {
  const actions: LifecycleAction[] = [];
  const dormancyMs = Math.max(1, policy.dormancyDays) * DAY_MS;
  const renewalMs = Math.max(1, policy.renewalReminderDays) * DAY_MS;

  for (const s of snapshots) {
    if (s.lastActivityAtMs !== null && nowMs - s.lastActivityAtMs >= dormancyMs) {
      const days = Math.floor((nowMs - s.lastActivityAtMs) / DAY_MS);
      actions.push({
        kind: "dormancy_check",
        workspaceId: s.workspaceId,
        planKey: s.planKey,
        priority: "medium",
        reason: `workspace silent for ${days}d`,
        dueAtMs: nowMs,
      });
    }

    if (s.highChurnSignals > 0) {
      actions.push({
        kind: "high_churn_escalation",
        workspaceId: s.workspaceId,
        planKey: s.planKey,
        priority: "high",
        reason: `${s.highChurnSignals} high-churn signal${s.highChurnSignals === 1 ? "" : "s"} need same-day owner follow-up`,
        dueAtMs: nowMs,
      });
    }

    if (s.renewalStatus === "active" && s.nextBillingAtMs !== null) {
      const msUntilRenewal = s.nextBillingAtMs - nowMs;
      if (msUntilRenewal >= 0 && msUntilRenewal <= renewalMs) {
        const days = Math.ceil(msUntilRenewal / DAY_MS);
        actions.push({
          kind: "renewal_reminder",
          workspaceId: s.workspaceId,
          planKey: s.planKey,
          priority: "medium",
          reason: `renewal in ${days}d; send ROI recap and right-sized plan prompt`,
          dueAtMs: nowMs,
        });
      }
    }

    if (s.renewalStatus === "canceled" || s.renewalStatus === "past_due") {
      actions.push({
        kind: "cancellation_offer",
        workspaceId: s.workspaceId,
        planKey: s.planKey,
        priority: "high",
        reason: `${s.renewalStatus} plan needs save offer or downgrade path`,
        dueAtMs: nowMs,
      });
    }
  }

  return actions.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));
}

function priorityRank(priority: LifecycleAction["priority"]): number {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}
