import { ActionExecutionError, type ActionExecutor, type ValidationResult } from "../approvals/executor.js";
import { loadConfig } from "../config/loader.js";
import { resolveVentureMemoryCaps } from "./caps.js";
import { getPlan, updatePlan } from "../db/repositories/venture-memory.js";
import { insertBacklogItem } from "../db/repositories/planning.js";
import { deriveRice } from "../planning/rice.js";

/**
 * The `venture.weekly_plan` approval executor (#197, ADR-0197). When the owner approves a drafted weekly
 * plan's #13 request, this flows the plan's items into the #115 `backlog_items` table — where the
 * existing #115 loop ranks + dispatches them through the venture-gated launcher (#172). The planning
 * loop owns drafting + the gate; #115/#172 own dispatch. Runs AS the owner (the requester); idempotent
 * (a plan already `dispatched` is a no-op). When `dispatchOnApprove` is off, the plan is marked
 * `approved` but no backlog rows are created (the owner wants to review before any work flows).
 */
export const VENTURE_WEEKLY_PLAN_ACTION = "venture.weekly_plan";

function validate(payload: unknown): ValidationResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "payload must be an object" };
  }
  const planId = (payload as Record<string, unknown>).planId;
  if (typeof planId !== "string" || planId.trim().length === 0) {
    return { ok: false, error: "planId required" };
  }
  return { ok: true };
}

export const ventureWeeklyPlanExecutor: ActionExecutor = {
  actionType: VENTURE_WEEKLY_PLAN_ACTION,
  validate,
  summarize: (payload) => {
    const planId = typeof payload.planId === "string" ? payload.planId : "?";
    const ideaId = typeof payload.ideaId === "string" ? payload.ideaId : "?";
    return `Approve weekly plan ${planId} for venture ${ideaId} — dispatch its backlog items`;
  },
  async execute(payload, ctx) {
    const planId = String(payload.planId);
    const plan = await getPlan(ctx.workspaceId, planId);
    if (!plan) throw new ActionExecutionError(`venture plan ${planId} not found`);
    if (plan.status === "dispatched") {
      return { planId, dispatched: 0, note: "already dispatched (idempotent)" };
    }

    const now = new Date();
    const caps = resolveVentureMemoryCaps(loadConfig(ctx.workspaceId).ventureMemory);
    if (!caps.dispatchOnApprove) {
      await updatePlan(ctx.workspaceId, planId, { status: "approved" }, now);
      return { planId, dispatched: 0, note: "approved (dispatchOnApprove off)" };
    }

    let dispatched = 0;
    for (const item of plan.items) {
      const rice = deriveRice({
        signalCount: item.signalCount,
        severityTier: item.severityTier,
        corroboratingSources: item.corroboratingSources,
        effortPoints: item.effortPoints,
      });
      await insertBacklogItem({
        workspaceId: ctx.workspaceId,
        ideaId: plan.ideaId,
        title: item.title,
        description: item.why,
        source: "manual",
        sourceRef: `venture-plan:${plan.id}`,
        reach: rice.reach,
        impact: rice.impact,
        confidencePct: rice.confidencePct,
        effort: rice.effort,
        isPivot: false,
        targetChannelId: null,
        targetAgentMemberId: null,
      });
      dispatched += 1;
    }
    await updatePlan(ctx.workspaceId, planId, { status: "dispatched" }, now);
    return { planId, dispatched };
  },
};
