import { evaluatePlanLimit, getPlan, type Plan } from "./plans.js";
import type { ActivePlan } from "./plan-service.js";

export interface CampaignLaneQuotaReaders {
  activePlanForWorkspace(workspaceId: string): Promise<ActivePlan | null | undefined>;
  countActiveCampaignLanes(workspaceId: string): Promise<number>;
}

export type CampaignLaneQuotaDecision =
  | { ok: true }
  | {
      ok: false;
      code: 402 | 403;
      error: string;
      resource: "active_campaign_lanes";
      limit: number;
      used: number;
      planKey: string;
      upgradeTrigger: string;
    };

function usablePlan(active: ActivePlan | null | undefined): Plan | null {
  if (!active) return null;
  if (active.status !== "active" || active.renewalStatus === "expired") return null;
  return getPlan(active.planKey) ?? null;
}

export async function decideCampaignLaneQuota(
  workspaceId: string,
  readers: CampaignLaneQuotaReaders,
): Promise<CampaignLaneQuotaDecision> {
  const active = await readers.activePlanForWorkspace(workspaceId);
  if (!active) return { ok: true };
  const plan = usablePlan(active);
  if (!plan) {
    return {
      ok: false,
      code: 402,
      error: "Your plan is not active. Update billing before starting another campaign lane.",
      resource: "active_campaign_lanes",
      limit: 0,
      used: 0,
      planKey: active.planKey,
      upgradeTrigger: "Update billing before starting another campaign lane.",
    };
  }
  const used = await readers.countActiveCampaignLanes(workspaceId);
  const decision = evaluatePlanLimit(plan, "activeCampaignLanes", used);
  if (decision.allowed) return { ok: true };
  return {
    ok: false,
    code: 403,
    error: `Active campaign-lane limit reached for ${plan.name}. ${decision.upgradeTrigger}`,
    resource: "active_campaign_lanes",
    limit: decision.limit,
    used,
    planKey: plan.key,
    upgradeTrigger: decision.upgradeTrigger,
  };
}
