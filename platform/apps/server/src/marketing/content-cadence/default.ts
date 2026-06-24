import type { SessionManager, SessionLogger } from "../../runtime/manager.js";
import { loadConfig } from "../../config/loader.js";
import { listWorkspaceIds } from "../../db/repositories/workspaces.js";
import { getWorkspaceOwnerMemberId } from "../../db/repositories/members.js";
import { getMaintenanceState } from "../../maintenance/flag.js";
import { createDefaultSeoRankService } from "../../seo/default.js";
import { createMarketingBriefService } from "../default.js";
import { ContentCadenceEngine } from "./engine.js";
import { buildKeywordPrevalidationSignal } from "./prevalidation.js";

/**
 * Wire the #416 content-cadence engine with the real seams: the deployment config block, the workspace
 * list, the owner-member resolver (the brief posts AS the owner), and the audited
 * {@link MarketingBriefService} launch. The timer is started in `index.ts` only when
 * `CONTENT_CADENCE_INTERVAL_MS > 0` (default OFF); the per-workspace flags are default-OFF + owner-first
 * ({@link resolveContentCadenceFlags}), and the daily watermark dedups repeats — so prod with the block
 * unset is byte-for-byte unchanged.
 */
export function createDefaultContentCadenceEngine(
  logger: SessionLogger,
  sessionManager: SessionManager,
): ContentCadenceEngine {
  const briefService = createMarketingBriefService(sessionManager);
  const seo = createDefaultSeoRankService();
  return new ContentCadenceEngine({
    // Read the block fresh each tick so a live config edit takes effect without a restart.
    config: () => loadConfig().contentCadence,
    listWorkspaceIds,
    resolveOwnerMemberId: async (workspaceId) =>
      (await getWorkspaceOwnerMemberId(workspaceId)) ?? undefined,
    brief: async (identity, input) => {
      const r = await briefService.brief(identity, {
        lead: input.lead,
        goal: input.goal,
        systemAuthorized: input.systemAuthorized,
      });
      return r.ok ? { ok: true } : { ok: false, code: r.code, error: r.error };
    },
    prevalidateKeyword: async (workspaceId, query) => {
      const summary = await seo.summary(workspaceId);
      return buildKeywordPrevalidationSignal({
        query,
        provider: summary.provider,
        connected: summary.connected,
        trackedKeywords: loadConfig(workspaceId).seo?.targetKeywords ?? [],
        latest: summary.latest.map((row) => ({
          keyword: row.keyword,
          position: row.position,
          url: row.url,
          country: row.country,
          observedAt: new Date(row.observedAtMs),
        })),
      });
    },
    maintenancePaused: async () => (await getMaintenanceState()).enabled,
    logger,
  });
}
