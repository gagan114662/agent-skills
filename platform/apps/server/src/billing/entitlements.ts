import type { ActivePlan, WorkspacePlanStore } from "./plan-service.js";
import { getPlan } from "./plans.js";

export type PlanQuotaResource = "agent" | "channel";

export interface PlanQuotaUsage {
  agents: number;
  channels: number;
}

export interface PlanQuotaReaders {
  activePlans: Pick<WorkspacePlanStore, "getActive">;
  countAgents(workspaceId: string): Promise<number>;
  countChannels(workspaceId: string): Promise<number>;
  now?: () => Date;
}

export type PlanQuotaDecision =
  | { ok: true; plan: ActivePlan | undefined }
  | {
      ok: false;
      statusCode: 402 | 403;
      error: string;
      plan: ActivePlan;
      limit: number;
      used: number;
      resource: PlanQuotaResource;
    };

function planIsCurrent(plan: ActivePlan, now: Date): boolean {
  return plan.status === "active" && plan.renewalStatus !== "expired" && plan.renewalStatus !== "canceled" && plan.expiresAt > now;
}

function limitFor(plan: ActivePlan, resource: PlanQuotaResource): number {
  if (resource === "agent") return plan.agentSeats;
  return getPlan(plan.planKey)?.productLimits.connectedChannels ?? plan.fleetSize;
}

function usedFor(usage: PlanQuotaUsage, resource: PlanQuotaResource): number {
  return resource === "agent" ? usage.agents : usage.channels;
}

export function decidePlanQuota(input: {
  plan: ActivePlan | undefined;
  usage: PlanQuotaUsage;
  resource: PlanQuotaResource;
  now: Date;
}): PlanQuotaDecision {
  if (!input.plan) return { ok: true, plan: undefined };
  const limit = limitFor(input.plan, input.resource);
  const used = usedFor(input.usage, input.resource);
  if (!planIsCurrent(input.plan, input.now)) {
    return {
      ok: false,
      statusCode: 402,
      error: "plan expired or canceled; update billing to continue",
      plan: input.plan,
      limit,
      used,
      resource: input.resource,
    };
  }
  if (limit > 0 && used >= limit) {
    return {
      ok: false,
      statusCode: 403,
      error: `${input.resource} quota exceeded for ${input.plan.planKey} plan`,
      plan: input.plan,
      limit,
      used,
      resource: input.resource,
    };
  }
  return { ok: true, plan: input.plan };
}

export async function checkPlanQuota(
  readers: PlanQuotaReaders,
  workspaceId: string,
  resource: PlanQuotaResource,
): Promise<PlanQuotaDecision> {
  const [plan, agents, channels] = await Promise.all([
    readers.activePlans.getActive(workspaceId),
    readers.countAgents(workspaceId),
    readers.countChannels(workspaceId),
  ]);
  return decidePlanQuota({
    plan,
    usage: { agents, channels },
    resource,
    now: readers.now?.() ?? new Date(),
  });
}
