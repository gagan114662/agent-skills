import { loadConfig } from "../config/loader.js";
import { resolveScaleCaps } from "../scale/caps.js";
import {
  listWorkspaceLiveSessions,
  listRecentWorkspaceSessions,
} from "../db/repositories/agent-sessions.js";
import { listEvaluations } from "../db/repositories/venture.js";
import { getIdea } from "../db/repositories/venture.js";
import { listTasks } from "../db/repositories/tasks.js";
import { getWorkspaceOwnerMemberId } from "../db/repositories/members.js";
import {
  createNotification,
  getPreferences,
  listNotificationsForMember,
} from "../db/repositories/notifications.js";
import { MissionControlService } from "./service.js";
import { shouldQueueActivationHealthAlert } from "./activation-alert.js";
import type { MissionDiagnostic, RecentFailureView } from "./diagnose.js";

/**
 * Production wiring for mission control (#147, ADR-0147). Read-only over the #25 live-session list +
 * the #71 tenant compute rate — no migration, no config flag (gated only by the #19 tenant boundary in
 * the route). Wiring it changes nothing until an owner opens the pane.
 *
 * #230: also wires the recent-sessions + activation reads behind the "why is nothing running?"
 * diagnostic, all over EXISTING workspace-scoped repos (no new query authority).
 */
async function alertActivationHealth(input: {
  workspaceId: string;
  diagnostic: MissionDiagnostic;
  recentFailures: RecentFailureView[];
  now: Date;
}): Promise<void> {
  const ownerMemberId = await getWorkspaceOwnerMemberId(input.workspaceId);
  if (!ownerMemberId) return;
  const prefs = await getPreferences(ownerMemberId);
  const existing = await listNotificationsForMember(input.workspaceId, ownerMemberId);
  if (!shouldQueueActivationHealthAlert({
    diagnostic: input.diagnostic,
    recentFailures: input.recentFailures,
    nowMs: input.now.getTime(),
    prefs,
    existing,
  })) return;
  await createNotification({
    workspaceId: input.workspaceId,
    recipientMemberId: ownerMemberId,
    type: "activation_health",
    excerpt: input.diagnostic.headline,
  });
}

export function createDefaultMissionControlService(): MissionControlService {
  return new MissionControlService({
    listLiveSessions: (workspaceId) => listWorkspaceLiveSessions(workspaceId),
    rate: (workspaceId) => resolveScaleCaps(loadConfig(workspaceId).scale).computeRateCentsPerMinute,
    recentSessions: async (workspaceId) =>
      (await listRecentWorkspaceSessions(workspaceId, 25)).map((s) => ({
        id: s.id,
        channelId: s.channelId,
        agentMemberId: s.agentMemberId,
        status: s.status,
        exitCode: s.exitCode,
        result: s.result,
        endedAtMs: s.endedAt ? s.endedAt.getTime() : null,
        createdAtMs: s.createdAt.getTime(),
      })),
    hasVenture: async (workspaceId) => (await listEvaluations(workspaceId)).length > 0,
    // The venture has work to pick up once its #96 loop produced an epic (epicTaskId set, #230 kickoff),
    // or there is any venture-labelled task on the board.
    hasOpenWork: async (workspaceId) => {
      const evals = await listEvaluations(workspaceId);
      for (const e of evals) {
        const idea = await getIdea(workspaceId, e.ideaId);
        if (idea?.epicTaskId) return true;
      }
      const tasks = await listTasks(workspaceId);
      return tasks.some((t) => t.labels.includes("venture"));
    },
    activationHealthAlert: alertActivationHealth,
  });
}
