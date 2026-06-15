import { loadConfig } from "../config/loader.js";
import { resolveAutomationCaps } from "./caps.js";
import { resolveSiteUrl } from "../marketing/site.js";
import { AutomationEngine, type AutomationLauncher } from "./engine.js";
import { automationStore } from "../db/repositories/automations.js";
import { getPersonaByHandle } from "../db/repositories/personas.js";
import { getControls } from "../db/repositories/autonomy.js";
import { createVentureAdmission } from "../venture/default.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import type { SessionLogger, SessionManager } from "../runtime/manager.js";

/**
 * Production wiring for Automations (#147, ADR-0147). Default-OFF (config `automations.enabled` +
 * `AUTOMATIONS_INTERVAL_MS`), so wiring it changes nothing until an owner opts in and creates an
 * automation. The launcher is the SAME venture-gated subagent launcher the #123 marketing fleet uses,
 * so a scheduled launch clears the #96 venture gate then the #71 admission chokepoint (kill switch,
 * tenant budget, concurrency) — and the agent it launches is a draft-only #123 persona, so any
 * external send still leaves through the #13 gate. No new launch authority, no new egress.
 */

/** A launcher that clears the #96 venture gate before launching through the #25 manager (the #123 path). */
function ventureGatedLauncher(sessionManager: SessionManager): AutomationLauncher {
  const gate = createVentureAdmission();
  return {
    launch: async (input) => {
      await gate.check(input.workspaceId);
      return sessionManager.launch(input);
    },
  };
}

/** Build the production AutomationEngine. The background timer is started in `index.ts`. */
export function createDefaultAutomationEngine(
  logger: SessionLogger,
  sessionManager: SessionManager,
): AutomationEngine {
  return new AutomationEngine({
    store: automationStore,
    launcher: ventureGatedLauncher(sessionManager),
    resolveAgentMember: async (workspaceId, handle) => {
      const persona = await getPersonaByHandle(workspaceId, handle);
      return persona ? { agentMemberId: persona.agentMemberId } : null;
    },
    caps: (workspaceId) => resolveAutomationCaps(loadConfig(workspaceId).automations),
    // #250: substitute the workspace's real site URL into the `{{site}}` template var (owner workspace ⇒
    // ipop.ai fallback) so a seeded SEO audit points the fleet at a real domain, not "our website".
    resolveSiteUrl: (workspaceId) => {
      const marketing = loadConfig(workspaceId).marketing;
      return resolveSiteUrl({
        workspaceId,
        ownerWorkspaceId: marketing.ownerWorkspaceId,
        configuredSiteUrl: marketing.siteUrl,
      });
    },
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    maintenancePaused: () => isMaintenanceActive(),
    logger,
  });
}
