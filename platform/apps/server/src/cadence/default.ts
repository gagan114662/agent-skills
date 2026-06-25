import type { SessionLogger, SessionManager } from "../runtime/manager.js";
import { loadConfig } from "../config/loader.js";
import { conversionsByChannelSince, failingChannelsSince } from "../db/repositories/acquisition.js";
import { getWorkspaceOwnerMemberId } from "../db/repositories/members.js";
import { listMemories } from "../db/repositories/memories.js";
import { createMarketingBriefService } from "../marketing/default.js";
import { resolveCadenceCaps } from "./caps.js";
import { CadenceEngine } from "./engine.js";
import type { CadenceOutcome } from "./playbook.js";

/**
 * Production wiring for the autonomous work cadence (#416, ADR-0416). The recurring tick that keeps the
 * fleet working ON ipop.ai's own growth (the draft-only dogfood playbook) so the work doesn't stop after a
 * single one-shot brief. Modelled on `venture-factory/default.ts`:
 *   - **caps** come from the layered config (`loadConfig(ws).cadence`, default-OFF + owner-first + capped).
 *   - **the owner work-list** is the resolved `ownerWorkspaceId` — the cadence only ever ticks the owner's
 *     own workspace by default (the engine still re-checks `isCadenceEnabledForWorkspace` per tick).
 *   - **launch** reuses the EXISTING owner-brief path (`createMarketingBriefService(...).brief`), posting
 *     AS the workspace owner human. It introduces NO new launch authority: every draft-only brief flows
 *     through the same audited #59/#96/#71 path, and anything that leaves the building stays #13-gated.
 *
 * Default-OFF: with no `cadence` config the timer is never started (`intervalMs` resolves to 0 in
 * `index.ts`) and even a started timer launches nothing (the per-workspace gate is OFF), so a deployment
 * that sets nothing is byte-for-byte unchanged.
 */
export function createDefaultCadenceEngine(
  sessionManager: SessionManager,
  logger: SessionLogger,
): CadenceEngine {
  // The owner-brief launcher (the SAME front door the dashboard brief composer uses). Built once.
  const briefService = createMarketingBriefService(sessionManager);

  return new CadenceEngine({
    caps: (workspaceId) => resolveCadenceCaps(loadConfig(workspaceId).cadence),
    // The work-list: the resolved owner workspace (owner-first). Empty (no tick) when no owner is named —
    // matching the config gate, which runs for nobody until an owner workspace is configured.
    ownerWorkspaces: () => {
      const ownerWs = resolveCadenceCaps(loadConfig().cadence).ownerWorkspaceId;
      return ownerWs ? [ownerWs] : [];
    },
    launch: async (workspaceId, task) => {
      // Post the brief AS the workspace owner human (the accountable requester). No owner ⇒ throw so the
      // engine treats it as "not launched" (no state advance) and retries next tick.
      const ownerMemberId = await getWorkspaceOwnerMemberId(workspaceId);
      if (!ownerMemberId) {
        throw new Error(`cadence: no owner member for workspace ${workspaceId}`);
      }
      const result = await briefService.brief(
        { workspaceId, memberId: ownerMemberId },
        { lead: task.lead, goal: task.goal },
      );
      // A non-ok brief (no fleet seeded yet, unknown lead, empty goal) is a denial: throw so the engine
      // does NOT advance the counter/cursor and retries the same task next cycle.
      if (!result.ok) {
        throw new Error(`cadence: brief denied (${result.code}) ${result.error}`);
      }
    },
    outcomes: async (workspaceId): Promise<CadenceOutcome[]> => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const [conversions, failures] = await Promise.all([
        conversionsByChannelSince(workspaceId, since),
        failingChannelsSince(workspaceId, since),
      ]);
      return [
        ...conversions.map((c) => ({
          outcomeKey: c.channel === "seo" ? "seo" : c.channel,
          result: "worked" as const,
          conversions: c.verified ? c.conversions : 0,
        })),
        ...failures.map((channel) => ({
          outcomeKey: channel === "seo" ? "seo" : channel,
          result: "failed" as const,
        })),
      ];
    },
    memoryContext: async (workspaceId) => {
      const memories = await listMemories(workspaceId, { limit: 5 });
      return memories.map((memory) => ({
        text: memory.content.text,
        source: memory.entity ?? memory.sourceType,
      }));
    },
    logger,
  });
}
