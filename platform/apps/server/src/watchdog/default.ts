import { loadConfig } from "../config/loader.js";
import { resolveWatchdogCaps } from "./caps.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { budgetExceeded, windowKey } from "../scale/usage.js";
import { WatchdogEngine, type WatchdogEscalator } from "./engine.js";
import { autonomyLauncherFrom } from "../autonomy/default.js";
import { watchdogRevivalStore } from "../db/repositories/watchdog.js";
import { listLiveSessions, finalizeSession } from "../db/repositories/agent-sessions.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { getControls } from "../db/repositories/autonomy.js";
import { createRequest } from "../db/repositories/approvals.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import { channelPoster } from "../runtime/default.js";
import type { SessionLogger } from "../runtime/manager.js";
import type { SessionManager } from "../runtime/manager.js";

/**
 * Production wiring for the Fleet Watchdog (#105). Every seam is real: the work-list, caps, kill
 * switch, dollar ceiling, durable revival store, the #92 launcher (reused verbatim as the reviver),
 * the dead-row finalizer, and the #13 escalation. The supervisor is default-OFF (config
 * `watchdog.enabled` + `WATCHDOG_INTERVAL_MS`), so wiring it changes nothing until an operator opts in.
 */

/** #13: enqueue a human escalation for a hopeless revival lineage (the Founder Console surface). */
const approvalEscalator: WatchdogEscalator = {
  escalate: async ({ workspaceId, session, record, reason }) => {
    const req = await createRequest({
      workspaceId,
      requesterMemberId: session.agentMemberId,
      actionType: "watchdog.escalate",
      payload: {
        sessionId: session.id,
        rootSessionId: record.rootSessionId,
        revivals: record.revivals,
        reason,
      },
      amount: null,
      summary:
        `Watchdog escalation: session ${session.id} could not be revived (${reason}) after ` +
        `${record.revivals} attempt(s) — human intervention needed.`,
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { sessionId: session.id, reason } }],
    });
    return { id: req.id };
  },
};

/** Build the production WatchdogEngine. The background timer is started in `index.ts`. */
export function createDefaultWatchdogEngine(
  logger: SessionLogger,
  sessionManager: SessionManager,
): WatchdogEngine {
  return new WatchdogEngine({
    listLiveSessions,
    caps: (workspaceId) => resolveWatchdogCaps(loadConfig(workspaceId).watchdog),
    // Infrastructure-time supervision is gated by the same #17 kill switch as autonomy launches.
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    // Dollar ceiling reuses the #71 scale budget — one tenant budget bounds sessions, ventures, AND
    // revivals; a workspace at its cap escalates instead of spending more reviving.
    budgetExhausted: async (workspaceId, now) =>
      budgetExceeded(
        (await getUsage(workspaceId, windowKey(now))).estimatedCostCents,
        resolveScaleCaps(loadConfig(workspaceId).scale).budgetCents,
      ),
    revivals: watchdogRevivalStore,
    // Revive = relaunch through the SAME #92 launcher the autonomy engine uses (so it passes the same
    // #71 admission chokepoint and lands on the same #70 worktree / #51 branch).
    reviver: autonomyLauncherFrom(sessionManager),
    finalizeDead: (sessionId, status) => finalizeSession(sessionId, { status }),
    escalator: approvalEscalator,
    poster: channelPoster,
    // #99: pause the supervisor during maintenance (same Redis flag the write-gate + autonomy loop read).
    maintenancePaused: () => isMaintenanceActive(),
    logger,
  });
}
