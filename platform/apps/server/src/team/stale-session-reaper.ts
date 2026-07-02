import { loadConfig } from "../config/loader.js";
import { listWorkspaceLiveSessions } from "../db/repositories/agent-sessions.js";
import type { SessionManager } from "../runtime/manager.js";
import type { StaleSessionReaper, StaleSessionReapResult } from "../routes/team.js";
import { resolveWatchdogCaps } from "../watchdog/caps.js";

export interface TeamRunStaleSessionReaperOptions {
  sessionManager: Pick<SessionManager, "cancel">;
  now?: () => Date;
}

/**
 * Submit-time stale-session cleanup for the live marketing room.
 *
 * The background fleet watchdog is still the general supervisor, but an owner starting a new team run is
 * also a safe moment to clear a previously orphaned/hung session in the same channel. The existing
 * SessionManager cancel path already handles both in-process runs and cross-process/orphan rows, so this
 * reuses that audited path.
 */
export function createTeamRunStaleSessionReaper({
  sessionManager,
  now = () => new Date(),
}: TeamRunStaleSessionReaperOptions): StaleSessionReaper {
  return {
    async reap(input): Promise<StaleSessionReapResult> {
      const live = await listWorkspaceLiveSessions(input.workspaceId);
      const cutoffMs = resolveWatchdogCaps(loadConfig(input.workspaceId).watchdog).staleCutoffMs;
      const nowMs = now().getTime();
      const scoped = live.filter((session) => session.channelId === input.channelId);
      const stale = scoped.filter((session) => nowMs - session.progressAt.getTime() >= cutoffMs);
      const reaped: StaleSessionReapResult["reaped"] = [];
      for (const session of stale) {
        const staleForMs = Math.max(0, nowMs - session.progressAt.getTime());
        try {
          const canceled = await sessionManager.cancel(session.id);
          reaped.push({ sessionId: session.id, staleForMs, canceled });
        } catch {
          reaped.push({ sessionId: session.id, staleForMs, canceled: false });
        }
      }
      return { scanned: scoped.length, reaped };
    },
  };
}
