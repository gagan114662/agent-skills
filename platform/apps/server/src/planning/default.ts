import { loadConfig } from "../config/loader.js";
import { resolvePlanningCaps } from "./caps.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { budgetExceeded, windowKey } from "../scale/usage.js";
import { PlanningService, type SpecApprovalQueue, type SpecDispatcher } from "./service.js";
import { autonomyLauncherFrom } from "../autonomy/default.js";
import { ventureGatedLauncher } from "../venture/admission.js";
import { createVentureAdmission } from "../venture/default.js";
import { createDefaultVentureMemoryService } from "../venture-memory/default.js";
import {
  insertBacklogItem,
  getBacklogItem,
  listBacklogItems,
  updateBacklogItem,
  insertPlanningSpec,
  getSpecForItem,
  listPlanningSpecs,
  linkSpecSession,
  linkSpecApproval,
  listActivePlanningWorkspaces,
} from "../db/repositories/planning.js";
import { listPolicyRulesWithId, createRequest } from "../db/repositories/approvals.js";
import { listWorkspaceMembers } from "../db/repositories/members.js";
import { evaluatePolicy } from "../approvals/policy.js";
import { getUsage, recordSessionCompute } from "../db/repositories/tenant-usage.js";
import { getControls } from "../db/repositories/autonomy.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import type { SessionManager } from "../runtime/manager.js";

/**
 * Production wiring for the Product Planning Loop (#115, ADR-0115). Default-OFF (config
 * `planning.enabled` + `PLANNING_INTERVAL_MS`), so wiring it changes nothing until an operator opts in.
 * The dispatcher adapts the **venture-gated** #96 launcher (a proposed build session clears the
 * fundable-venture admission gate first); a sensitive dispatch creates a **pending** #13 request a human
 * approves. No change to `approvals/policy.ts` or the executor — promotion reuses the existing gate.
 */

/** The #95 policy action a planning dispatch is gated under (sensitive-by-default). */
export const PLANNING_DISPATCH_ACTION = "planning.dispatch";

/**
 * Sensitive-by-default auto-dispatch check (#95): a planning dispatch is auto-allowed ONLY when an
 * explicit workspace policy rule opts it in (a rule with `requiresApproval: false`). No rule ⇒ gate.
 */
async function autoDispatchAllowed(workspaceId: string): Promise<boolean> {
  const rules = await listPolicyRulesWithId(workspaceId);
  const rule = rules.find((r) => r.actionType === PLANNING_DISPATCH_ACTION);
  if (!rule) return false; // sensitive-by-default
  return !evaluatePolicy({ actionType: PLANNING_DISPATCH_ACTION }, [rule]).requiresApproval;
}

/**
 * The #197 venture-memory service, used here ONLY to retrieve a venture's brief (memory + OKR drift) and
 * prepend it to a build session's task — the AC1 "retrieved into every new session's context" seam. A
 * brand-new venture returns "" (no injection). Construction is cheap (seams only; no timer started).
 */
const ventureMemoryForBrief = createDefaultVentureMemoryService();

/** The #92 launcher (venture-gated #96), adapted to launch a build agent into the item's target. */
function specDispatcherFrom(sessionManager: SessionManager): SpecDispatcher {
  const launcher = ventureGatedLauncher(autonomyLauncherFrom(sessionManager), createVentureAdmission());
  return {
    dispatch: async ({ workspaceId, item, spec }) => {
      if (!item.targetChannelId || !item.targetAgentMemberId) {
        // An item with no launch target can never auto-dispatch — the operator must supply one (or it
        // stays #13-gated). Fail loud: the dispatch decision should never route such an item to auto.
        throw new Error("planning: cannot auto-dispatch a backlog item with no target channel/agent");
      }
      let task = `Implement the spec "${spec.title}" (backlog item ${item.id}).\n\n${spec.body}`;
      // #197 AC1: a venture build session starts with the venture's durable memory + OKR drift, so the
      // session is not a goldfish. Best-effort — a memory failure never blocks the dispatch.
      if (item.ideaId) {
        try {
          const brief = await ventureMemoryForBrief.sessionBrief(workspaceId, item.ideaId);
          if (brief) task = `${brief}\n\n---\n\n${task}`;
        } catch {
          // memory retrieval is non-critical; dispatch proceeds without the brief
        }
      }
      return launcher.launch({
        workspaceId,
        channelId: item.targetChannelId,
        agentMemberId: item.targetAgentMemberId,
        createdByMemberId: item.targetAgentMemberId,
        task,
        harnessEnv: { AGENT_PLANNING_DISPATCH: "1" },
      });
    },
  };
}

/**
 * Resolve the #13 requester for a planning dispatch: the item's target agent if set, else the
 * workspace's first human member (the owner), else any member. `requester_member_id` is NOT NULL with
 * an FK to members (the SRE-loop gotcha), so a metric-sourced item with no target still needs a real
 * member to anchor the approval.
 */
async function resolveRequester(workspaceId: string, targetAgentMemberId: string | null): Promise<string> {
  if (targetAgentMemberId) return targetAgentMemberId;
  const members = await listWorkspaceMembers(workspaceId);
  const human = members.find((m) => m.kind === "human");
  const member = human ?? members[0];
  if (!member) throw new Error("planning: cannot enqueue an approval — workspace has no members");
  return member.id;
}

/** The #13 approval queue for a sensitive planning dispatch (surfaced in the #104 console). */
const specApprovalQueue: SpecApprovalQueue = {
  enqueue: async ({ workspaceId, item, spec, reason }) => {
    const req = await createRequest({
      workspaceId,
      requesterMemberId: await resolveRequester(workspaceId, item.targetAgentMemberId),
      actionType: PLANNING_DISPATCH_ACTION,
      payload: { backlogItemId: item.id, specId: spec.id, source: item.source, sourceRef: item.sourceRef },
      amount: null,
      summary:
        `Planning dispatch (${reason}): "${item.title}" — propose a build session for spec ` +
        `"${spec.title}". Needs a human to approve launching a build agent.`,
      status: "pending", // sensitive-by-default — a human approves the launch
      expiresAt: null,
      events: [{ type: "requested", detail: { backlogItemId: item.id, reason } }],
    });
    return { id: req.id };
  },
};

export function createDefaultPlanningService(sessionManager: SessionManager): PlanningService {
  return new PlanningService({
    backlog: {
      insert: insertBacklogItem,
      get: getBacklogItem,
      list: listBacklogItems,
      update: updateBacklogItem,
    },
    specs: {
      insert: insertPlanningSpec,
      getForItem: getSpecForItem,
      list: listPlanningSpecs,
      linkSession: linkSpecSession,
      linkApproval: linkSpecApproval,
    },
    dispatcher: specDispatcherFrom(sessionManager),
    approvals: specApprovalQueue,
    caps: (workspaceId) => resolvePlanningCaps(loadConfig(workspaceId).planning),
    autoDispatchAllowed,
    budgetExhausted: async (workspaceId, now) =>
      budgetExceeded(
        (await getUsage(workspaceId, windowKey(now))).estimatedCostCents,
        resolveScaleCaps(loadConfig(workspaceId).scale).budgetCents,
      ),
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    usage: {
      charge: async (workspaceId, costCents, now) => {
        if (costCents > 0) await recordSessionCompute(workspaceId, windowKey(now), 0, costCents);
      },
    },
    activeWorkspaces: listActivePlanningWorkspaces,
    maintenancePaused: () => isMaintenanceActive(),
  });
}

export { resolvePlanningCaps };
