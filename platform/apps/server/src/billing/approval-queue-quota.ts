import type { ActivePlan, WorkspacePlanStore } from "./plan-service.js";
import { getPlan } from "./plans.js";

export interface ApprovalQueueQuotaReaders {
  activePlans: Pick<WorkspacePlanStore, "getActive">;
  countPendingApprovals(workspaceId: string): Promise<number>;
  now?: () => Date;
}

export type ApprovalQueueQuotaDecision =
  | { ok: true; plan: ActivePlan | undefined; limit: number | null; used: number }
  | {
      ok: false;
      statusCode: 402 | 403;
      error: string;
      plan: ActivePlan;
      limit: number;
      used: number;
    };

function planIsCurrent(plan: ActivePlan, now: Date): boolean {
  return (
    plan.status === "active" &&
    plan.renewalStatus !== "expired" &&
    plan.renewalStatus !== "canceled" &&
    plan.expiresAt > now
  );
}

function approvalQueueLimit(plan: ActivePlan): number {
  return getPlan(plan.planKey)?.productLimits.approvalQueueSize ?? Number.POSITIVE_INFINITY;
}

export function decideApprovalQueueQuota(input: {
  plan: ActivePlan | undefined;
  pendingApprovals: number;
  now: Date;
}): ApprovalQueueQuotaDecision {
  const used = Math.max(0, Math.trunc(input.pendingApprovals));
  if (!input.plan) return { ok: true, plan: undefined, limit: null, used };
  const limit = approvalQueueLimit(input.plan);
  if (!planIsCurrent(input.plan, input.now)) {
    return {
      ok: false,
      statusCode: 402,
      error: "plan expired or canceled; update billing to continue",
      plan: input.plan,
      limit,
      used,
    };
  }
  if (Number.isFinite(limit) && used >= limit) {
    const plan = getPlan(input.plan.planKey);
    return {
      ok: false,
      statusCode: 403,
      error: `approval queue limit reached for ${input.plan.planKey} plan${plan ? `: ${plan.upgradeTrigger}` : ""}`,
      plan: input.plan,
      limit,
      used,
    };
  }
  return { ok: true, plan: input.plan, limit, used };
}

export async function checkApprovalQueueQuota(
  readers: ApprovalQueueQuotaReaders,
  workspaceId: string,
): Promise<ApprovalQueueQuotaDecision> {
  const [plan, pendingApprovals] = await Promise.all([
    readers.activePlans.getActive(workspaceId),
    readers.countPendingApprovals(workspaceId),
  ]);
  return decideApprovalQueueQuota({
    plan,
    pendingApprovals,
    now: readers.now?.() ?? new Date(),
  });
}
