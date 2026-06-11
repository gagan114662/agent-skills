import { loadConfig } from "../config/loader.js";
import { resolveVentureCaps } from "./caps.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { VentureAdmission } from "./admission.js";
import { VentureEngine } from "./engine.js";
import {
  VentureService,
  type ApprovalEnqueuer,
  type EpicEmitter,
  type EvidenceGatherer,
  type MemoryRecorder,
  type PersonaScorer,
  type UsageMeter,
  type VentureRepo,
} from "./service.js";
import type { DemandEvidenceSource } from "../demand/service.js";
import type { VoiceEvidenceSource } from "../voice/service.js";
import { RUBRIC_DIMENSIONS, type PersonaScorecard } from "./rubric.js";
import { windowKey } from "../scale/usage.js";
import {
  createIdea,
  getIdea,
  updateIdeaStatus,
  setIdeaEpic,
  insertScorecard,
  latestScorecard,
  setScorecardVerdict,
  hasPassingUnexpiredScorecard,
  insertIteration,
  listIterations,
  getOrCreateEvaluation,
  getEvaluation,
  updateEvaluation,
  listActiveEvaluations,
  listActiveEvaluationWorkspaces,
} from "../db/repositories/venture.js";
import { createRequest } from "../db/repositories/approvals.js";
import { upsertMemory } from "../db/repositories/memories.js";
import { createTask } from "../db/repositories/tasks.js";
import { getUsage, recordSessionCompute } from "../db/repositories/tenant-usage.js";
import { getControls } from "../db/repositories/autonomy.js";
import type { SessionLogger } from "../runtime/manager.js";

/**
 * Production wiring for the Venture Loop (#96). The repo + the #13/#14/#15 seams are real; the
 * evidence gatherer and persona scorer are **deterministic stand-ins** (no web research, no model
 * spend) — the spec defers the live-research evidence provider and the #59 LLM-backed persona scorer
 * (whose prompts live in `personas.ts`) to a follow-up. The loop, persistence, decision, and gate are
 * fully real.
 */

/** The full repository (a superset of {@link VentureRepo}, also exposing the gate's lookup). */
export const ventureRepo = {
  createIdea,
  getIdea,
  updateIdeaStatus,
  setIdeaEpic,
  insertScorecard,
  latestScorecard,
  setScorecardVerdict,
  hasPassingUnexpiredScorecard,
  insertIteration,
  listIterations,
  getOrCreateEvaluation,
  getEvaluation,
  updateEvaluation,
  listActiveEvaluations,
  listActiveEvaluationWorkspaces,
} satisfies VentureRepo & {
  hasPassingUnexpiredScorecard: (workspaceId: string, now: Date) => Promise<boolean>;
  listActiveEvaluationWorkspaces: () => Promise<string[]>;
};

/**
 * Dollar-ceiling meter (#96 hardening): reads/charges the SAME #71 tenant-usage accounting that bounds
 * session spend, so an evaluation and a session draw from one budget — and the same cap stops both.
 */
const usageMeter: UsageMeter = {
  spentCents: async (workspaceId, now) =>
    (await getUsage(workspaceId, windowKey(now))).estimatedCostCents,
  charge: async (workspaceId, costCents, now) => {
    if (costCents > 0) await recordSessionCompute(workspaceId, windowKey(now), 0, costCents);
  },
};

/**
 * Stub evidence gatherer: derives candidate claims from the idea's own fields and marks them
 * **assumptions** (no source) — honest about the deferred live-research seam ("every claim needs a
 * source or is marked an assumption").
 */
const stubEvidenceGatherer: EvidenceGatherer = {
  gather: async (idea) => [
    { claim: `Problem: ${idea.problem}`, source: null, assumption: true },
    { claim: `Market path: ${idea.marketPath}`, source: null, assumption: true },
    { claim: `Insight: ${idea.insight}`, source: null, assumption: true },
  ],
};

function card(value: number): PersonaScorecard {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, value])) as PersonaScorecard;
}

/**
 * Deterministic stand-in scorer: the Advocate is optimistic, the adversarial Reviewer skeptical, both
 * scaled by how much of the evidence is actually sourced (vs assumed). A real #59 scorer that runs the
 * `personas.ts` prompts through two subagent sessions is the deferred follow-up.
 */
const heuristicPersonaScorer: PersonaScorer = {
  score: async (_idea, evidence) => {
    const total = evidence.length || 1;
    const sourced = evidence.filter((e) => !e.assumption && e.source).length;
    const ratio = sourced / total; // 0 when everything is an unverified assumption
    return { advocate: card(5 + 5 * ratio), reviewer: card(2 + 6 * ratio) };
  },
};

/** #13: enqueue a borderline idea for human judgment (governance approvals queue). */
const approvalEnqueuer: ApprovalEnqueuer = {
  enqueue: async ({ workspaceId, ideaId, score, reasoning, createdByMemberId }) => {
    const req = await createRequest({
      workspaceId,
      requesterMemberId: createdByMemberId,
      actionType: "venture.escalate",
      payload: { ideaId, score },
      amount: null,
      summary: `Venture escalation: idea ${ideaId} scored ${score} (borderline) — ${reasoning}`,
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { ideaId, score } }],
    });
    return { id: req.id };
  },
};

/** #15: record a KILL verdict to the memory graph so the angle is never blindly retried. */
const memoryRecorder: MemoryRecorder = {
  record: async ({ workspaceId, ideaId, verdict, reasoning, createdByMemberId }) => {
    const mem = await upsertMemory({
      workspaceId,
      type: "decision",
      content: { text: `Venture ${verdict}: ${reasoning}`, ideaId, verdict },
      entity: `venture:${ideaId}`,
      dedupeKey: `venture-verdict:${ideaId}`,
      sourceType: "task", // within the memories_source_type_ck set (message|task|file|event|manual)
      sourceId: null,
      createdByMemberId,
    });
    return { id: mem.id };
  },
};

/** #14: emit the build epic when an idea is FUNDed (unlocks autonomy budget). */
const epicEmitter: EpicEmitter = {
  emit: async ({ workspaceId, idea, createdByMemberId }) => {
    const task = await createTask({
      workspaceId,
      title: `Build funded venture: ${idea.problem}`,
      description:
        `Funded by the Venture Loop (#96).\n` +
        `User: ${idea.targetUser}\nInsight: ${idea.insight}\n` +
        `Wedge: ${idea.wedge}\nMarket: ${idea.marketPath}`,
      labels: ["venture", "epic"],
      createdByMemberId,
    });
    return { id: task.id };
  },
};

/**
 * Build the production VentureService over the real repo + the #13/#14/#15/#71 seams. The optional #101
 * `demand` source supplies externally-attributed willingness-to-pay evidence; when present and non-empty
 * for an idea, it REPLACES the synthetic demand-dimension score (default-OFF: absent ⇒ unchanged scoring).
 */
export function createDefaultVentureService(
  now?: () => Date,
  demand?: DemandEvidenceSource,
  voice?: VoiceEvidenceSource,
): VentureService {
  return new VentureService({
    repo: ventureRepo,
    evidence: stubEvidenceGatherer,
    scorer: heuristicPersonaScorer,
    approvals: approvalEnqueuer,
    memory: memoryRecorder,
    epics: epicEmitter,
    caps: (workspaceId) => resolveVentureCaps(loadConfig(workspaceId).venture),
    usage: usageMeter,
    // The dollar ceiling reuses the #71 scale budget — one tenant budget bounds sessions AND ventures.
    scaleBudgetCents: (workspaceId) => resolveScaleCaps(loadConfig(workspaceId).scale).budgetCents,
    // Infrastructure-time advancement is gated by the same #17 kill switch as autonomy launches.
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    demand,
    // #114 customer-voice overlay: real post-launch voice replaces the synthetic problemSeverity dimension.
    voice,
    now,
  });
}

/** Build the production VentureEngine (#96 scheduled tick). The timer is started in `index.ts`. */
export function createDefaultVentureEngine(
  logger: SessionLogger,
  demand?: DemandEvidenceSource,
): VentureEngine {
  return new VentureEngine({
    service: createDefaultVentureService(undefined, demand),
    listActiveEvaluationWorkspaces,
    logger,
  });
}

/**
 * Build the autonomy admission gate. Reads the per-workspace venture flag (default OFF → the gate
 * admits unconditionally) and the passing-scorecard lookup. `app.ts` composes this into the autonomy
 * launcher via {@link ventureGatedLauncher}.
 */
export function createVentureAdmission(
  configLoader: (workspaceId: string) => { venture?: Parameters<typeof resolveVentureCaps>[0] } = (
    workspaceId,
  ) => loadConfig(workspaceId),
): VentureAdmission {
  return new VentureAdmission({
    config: (workspaceId) => ({ enabled: resolveVentureCaps(configLoader(workspaceId).venture).enabled }),
    hasPassingUnexpired: (workspaceId, now) =>
      ventureRepo.hasPassingUnexpiredScorecard(workspaceId, now),
  });
}
