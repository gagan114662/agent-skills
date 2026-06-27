import type { ActivePlan } from "./plan-service.js";
import { getPlan } from "./plans.js";

export interface DashboardHistoryPlanReaders {
  activePlanForWorkspace(workspaceId: string): Promise<ActivePlan | null | undefined>;
}

export function dashboardHistoryCutoffForPlan(
  active: ActivePlan | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (
    !active ||
    active.status !== "active" ||
    active.renewalStatus === "expired" ||
    active.renewalStatus === "canceled" ||
    active.expiresAt <= now
  ) {
    return null;
  }
  const plan = getPlan(active.planKey);
  if (!plan) return null;
  const days = Math.max(1, Math.trunc(plan.productLimits.dashboardHistoryDays));
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function dashboardHistoryCutoffForWorkspace(
  workspaceId: string,
  readers: DashboardHistoryPlanReaders,
  now: Date = new Date(),
): Promise<Date | null> {
  return dashboardHistoryCutoffForPlan(await readers.activePlanForWorkspace(workspaceId), now);
}
