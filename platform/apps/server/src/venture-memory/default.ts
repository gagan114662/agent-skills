import { loadConfig } from "../config/loader.js";
import { resolveVentureMemoryCaps } from "./caps.js";
import {
  VentureMemoryService,
  ventureEntity,
  ventureMemoryContent,
  ventureMemoryDedupeKey,
} from "./service.js";
import type { PlanRecord } from "./types.js";
import { upsertMemory } from "../db/repositories/memories.js";
import {
  listVentureMemoryNodes,
  insertOkr,
  listOkrsForVenture,
  upsertPlan,
  updatePlan,
  upsertPlaybook,
  listPlaybooks,
} from "../db/repositories/venture-memory.js";
import {
  getIdea,
  listEvaluations,
  listActiveEvaluationWorkspaces,
  latestScorecard,
} from "../db/repositories/venture.js";
import { listVerifierResults } from "../db/repositories/verifier-results.js";
import { listBacklogItems } from "../db/repositories/planning.js";
import { createRequest } from "../db/repositories/approvals.js";
import { listWorkspaceMembers } from "../db/repositories/members.js";
import { getControls } from "../db/repositories/autonomy.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import { VENTURE_WEEKLY_PLAN_ACTION } from "./executor.js";

/**
 * Production wiring for Venture Memory & Planning (#197, ADR-0197). Default-OFF (config
 * `ventureMemory.enabled` + `VENTURE_PLANNING_INTERVAL_MS`), so wiring it changes nothing until an
 * operator opts in. Venture MEMORY reuses the #15 `memories` table (`upsertMemory` +
 * `listVentureMemoryNodes`); the weekly plan lands as a **pending** #13 request a human approves (and
 * which surfaces in the #173 decision queue); on approval the `venture.weekly_plan` executor flows the
 * plan items into the #115 backlog (which auto-dispatches). No new launcher; no change to the venture
 * loop. The go/no-go's verified-metric input is the #106 `verifier_results` (passed receipts for the
 * venture) — never the self-reported #96 score.
 */

/**
 * Resolve the #13 requester for a plan approval: the workspace's first human member (the owner), else
 * any member. `requester_member_id` is NOT NULL with an FK to members (the SRE/planning gotcha).
 */
async function resolveRequester(workspaceId: string): Promise<string> {
  const members = await listWorkspaceMembers(workspaceId);
  const human = members.find((m) => m.kind === "human");
  const member = human ?? members[0];
  if (!member)
    throw new Error("venture-memory: cannot enqueue an approval — workspace has no members");
  return member.id;
}

/** A short brand-voice summary for the owner decision queue (cites the go/no-go + #200). */
function planSummary(plan: PlanRecord): string {
  const verdict = plan.goNoGo === "go" ? "GO" : "NO-GO";
  return (
    `Weekly plan for venture ${plan.ideaId} (${plan.weekKey}) — ${verdict}, ${plan.items.length} item(s). ` +
    `Approve to dispatch the backlog. ${plan.rationale}`
  );
}

export function createDefaultVentureMemoryService(): VentureMemoryService {
  return new VentureMemoryService({
    caps: (workspaceId) => resolveVentureMemoryCaps(loadConfig(workspaceId).ventureMemory),
    memory: {
      record: async (input) =>
        upsertMemory({
          workspaceId: input.workspaceId,
          type: "venture_memory",
          entity: ventureEntity(input.ideaId),
          content: ventureMemoryContent({
            kind: input.kind,
            text: input.text,
            why: input.why ?? null,
            sourceRef: input.sourceRef ?? null,
          }),
          dedupeKey: ventureMemoryDedupeKey(input.ideaId, input.kind, input.text),
          sourceType: "manual", // the #15 source_type CHECK set is message|task|file|event|manual
          createdByMemberId: input.createdByMemberId ?? null,
        }),
      nodes: (workspaceId, ideaId, includeStale) =>
        listVentureMemoryNodes(workspaceId, ventureEntity(ideaId), includeStale),
    },
    okrs: {
      insert: insertOkr,
      listForVenture: listOkrsForVenture,
    },
    plans: {
      upsert: upsertPlan,
      linkApproval: (workspaceId, id, approvalRequestId, now) =>
        updatePlan(workspaceId, id, { approvalRequestId }, now),
    },
    playbooks: {
      upsert: upsertPlaybook,
      list: listPlaybooks,
    },
    ventures: {
      ventures: async (workspaceId) =>
        Promise.all(
          (await listEvaluations(workspaceId)).map(async (e) => {
            const idea = await getIdea(workspaceId, e.ideaId);
            return {
              ideaId: e.ideaId,
              category: idea?.marketPath ?? idea?.segment ?? null,
              segment: idea?.segment ?? null,
              targetUser: idea?.targetUser ?? null,
            };
          }),
        ),
    },
    scorecard: {
      // Externally-verified (#106): passed verifier receipts whose claim references this venture. This
      // — NOT the self-reported #96 score — is the only input that can flip the go/no-go to GO (#200).
      verifiedMetricCount: async (workspaceId, ideaId) => {
        const passed = await listVerifierResults(workspaceId, { status: "passed", limit: 200 });
        return passed.filter((r) => r.claimRef.includes(ideaId)).length;
      },
      latestScore: async (workspaceId, ideaId) =>
        (await latestScorecard(workspaceId, ideaId))?.score ?? null,
    },
    backlog: {
      openTitles: async (workspaceId, ideaId) =>
        (await listBacklogItems(workspaceId, ["proposed", "specced", "dispatched"]))
          .filter((b) => b.ideaId === ideaId)
          .map((b) => b.title),
    },
    approvals: {
      enqueue: async ({ workspaceId, plan }) => {
        const req = await createRequest({
          workspaceId,
          requesterMemberId: await resolveRequester(workspaceId),
          actionType: VENTURE_WEEKLY_PLAN_ACTION,
          payload: {
            planId: plan.id,
            ideaId: plan.ideaId,
            weekKey: plan.weekKey,
            goNoGo: plan.goNoGo,
            itemCount: plan.items.length,
          },
          amount: null,
          summary: planSummary(plan),
          status: "pending", // sensitive-by-default — the owner approves the dispatch
          expiresAt: null,
          events: [{ type: "requested", detail: { planId: plan.id, weekKey: plan.weekKey } }],
        });
        return { id: req.id };
      },
    },
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    activeWorkspaces: listActiveEvaluationWorkspaces,
    maintenancePaused: () => isMaintenanceActive(),
  });
}

export { resolveVentureMemoryCaps };
