import { loadConfig } from "../config/loader.js";
import { resolveInsightCaps } from "./caps.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { InsightMiner, type KilledAngleStore, type Miner, type UsageMeter, type VentureIdeaCreator } from "./service.js";
import { InsightEngine } from "./engine.js";
import { insightDedupeKey } from "./dedupe.js";
import { windowKey } from "../scale/usage.js";
import {
  createSource,
  listSources,
  listCandidateSources,
  setSourceStatus,
  createInsight,
  insertEvidence,
  listEvidence,
  getInsight,
  listInsights,
  setInsightStatus,
  setInsightPromotion,
  listCandidateSourceWorkspaces,
} from "../db/repositories/insights.js";
import { upsertMemory, listMemories } from "../db/repositories/memories.js";
import { getUsage, recordSessionCompute } from "../db/repositories/tenant-usage.js";
import { getControls } from "../db/repositories/autonomy.js";
import { createDefaultVentureService } from "../venture/default.js";
import type { InsightInput, InsightSource } from "./types.js";
import type { SessionLogger } from "../runtime/manager.js";

/**
 * Production wiring for the Insight Miner (#100). The repo + the #71/#15/#96 seams are real; the
 * **miner itself is a deterministic stand-in** (no web scraping, no model spend) — the spec defers the
 * live web/changelog/LLM provider to a follow-up, exactly as #96 deferred its live evidence gatherer.
 * The ranking, persistence, dedupe, gating, promotion, and tick are fully real.
 */

export const insightRepo = {
  createSource,
  listSources,
  listCandidateSources,
  setSourceStatus,
  createInsight,
  insertEvidence,
  listEvidence,
  getInsight,
  listInsights,
  setInsightStatus,
  setInsightPromotion,
};

/**
 * Dollar-ceiling meter (#71): reads/charges the SAME `tenant_usage` accounting that bounds session +
 * venture spend, so mining draws from one tenant budget — and the same cap stops all three.
 */
const usageMeter: UsageMeter = {
  spentCents: async (workspaceId, now) =>
    (await getUsage(workspaceId, windowKey(now))).estimatedCostCents,
  charge: async (workspaceId, costCents, now) => {
    if (costCents > 0) await recordSessionCompute(workspaceId, windowKey(now), 0, costCents);
  },
};

/** Map a candidate source kind to the insight kind it yields. */
function insightKindFor(source: InsightSource): InsightInput["kind"] {
  switch (source.kind) {
    case "owner_secret":
      return "owner_secret";
    case "community":
    case "reviews":
    case "support_forum":
      return "pain";
    default:
      return "why_now";
  }
}

/**
 * Stub miner: derives ONE structured insight per candidate source from the source's own fields, citing
 * the source URL + recency (honest about the deferred live provider — pain/competition are scaled from
 * the source's evidence strength, not analysed from raw text). A real scraper/LLM analyser is the
 * deferred follow-up.
 */
const stubMiner: Miner = {
  mine: async (source) => {
    const scaled = Math.max(0, Math.min(10, Math.round(source.evidenceStrength / 10)));
    const insight: InsightInput = {
      kind: insightKindFor(source),
      statement: source.title || `Signal from ${source.kind} source`,
      painIntensity: scaled,
      competitionAbsence: scaled,
      freshnessAt: source.observedAt,
      evidence: source.url
        ? [{ sourceUrl: source.url, excerpt: source.title, observedAt: source.observedAt, sourceId: source.id }]
        : [],
      sourceId: source.id,
    };
    return [insight];
  },
};

/** #96 SOURCE: promote an insight into a venture idea via the real `VentureService.submit`. */
const ventureCreator: VentureIdeaCreator = {
  submit: async (workspaceId, input, createdByMemberId) =>
    createDefaultVentureService().submit(workspaceId, input, createdByMemberId),
};

/**
 * #15 killed-angle store. KILLed angles are recorded as `insight_kill` memory nodes keyed by the
 * insight dedupe key (idempotent via the memory dedup UNIQUE); `listKilledKeys` reads them back so a
 * later mine/promote suppresses an uncited repeat.
 */
const killedAngleStore: KilledAngleStore = {
  listKilledKeys: async (workspaceId) => {
    const nodes = await listMemories(workspaceId, { type: "insight_kill" });
    return nodes
      .map((n) => (typeof n.content.angleKey === "string" ? n.content.angleKey : null))
      .filter((k): k is string => !!k);
  },
  recordKill: async ({ workspaceId, dedupeKey, statement, reasoning, createdByMemberId }) => {
    await upsertMemory({
      workspaceId,
      type: "insight_kill",
      content: { text: `Insight KILL: ${reasoning}`, angleKey: dedupeKey, statement },
      entity: `insight:${dedupeKey}`,
      dedupeKey: `insight-kill:${dedupeKey}`,
      sourceType: "manual", // within the memories_source_type_ck set (message|task|file|event|manual)
      sourceId: null,
      createdByMemberId,
    });
  },
};

/** Build the production InsightMiner over the real repo + the #71/#15/#96/#17 seams. */
export function createDefaultInsightMiner(now?: () => Date): InsightMiner {
  return new InsightMiner({
    repo: insightRepo,
    miner: stubMiner,
    ventures: ventureCreator,
    killedAngles: killedAngleStore,
    caps: (workspaceId) => resolveInsightCaps(loadConfig(workspaceId).insight),
    usage: usageMeter,
    // The dollar ceiling reuses the #71 scale budget — one tenant budget bounds sessions, ventures, AND mining.
    scaleBudgetCents: (workspaceId) => resolveScaleCaps(loadConfig(workspaceId).scale).budgetCents,
    // Mining is gated by the same #17 kill switch as autonomy launches + the venture loop.
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    now,
  });
}

/** Build the production InsightEngine (#100 scheduled tick). The timer is started in `index.ts`. */
export function createDefaultInsightEngine(logger: SessionLogger): InsightEngine {
  return new InsightEngine({
    miner: createDefaultInsightMiner(),
    listCandidateSourceWorkspaces,
    logger,
  });
}

export { insightDedupeKey };
