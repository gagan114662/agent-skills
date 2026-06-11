import { loadConfig } from "../config/loader.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { listWorkspaceLiveSessions } from "../db/repositories/agent-sessions.js";
import { MissionControlService } from "./service.js";

/**
 * Production wiring for mission control (#147, ADR-0147). Read-only over the #25 live-session list +
 * the #71 tenant compute rate — no migration, no config flag (gated only by the #19 tenant boundary in
 * the route). Wiring it changes nothing until an owner opens the pane.
 */
export function createDefaultMissionControlService(): MissionControlService {
  return new MissionControlService({
    listLiveSessions: (workspaceId) => listWorkspaceLiveSessions(workspaceId),
    rate: (workspaceId) => resolveScaleCaps(loadConfig(workspaceId).scale).computeRateCentsPerMinute,
  });
}
