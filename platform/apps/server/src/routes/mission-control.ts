import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { getAgentSessionById } from "../db/repositories/agent-sessions.js";
import { postMessage } from "../db/repositories/messages.js";
import { publishMessageEvent } from "../realtime/bus.js";
import type { SessionManager } from "../runtime/manager.js";
import type { MissionControlService } from "../mission-control/service.js";

/**
 * Live mission-control routes (#147, ADR-0147 §6) under `/workspaces/:wid/mission-control`. A read
 * endpoint over the pure {@link MissionControlService}, plus two tenant-scoped controls — steer (the
 * audited #53 path: record the steer message, then best-effort inject) and stop (wrap #25 cancel).
 * Each control resolves the session's owning workspace and 404s if it is not the caller's (the #19
 * IDOR boundary for live controls).
 */
export interface MissionControlRoutesOptions {
  service: MissionControlService;
  sessionManager: SessionManager;
}

export async function missionControlRoutes(
  app: FastifyInstance,
  opts: MissionControlRoutesOptions,
): Promise<void> {
  const { service, sessionManager } = opts;

  /** The live fleet (status / elapsed / estimated spend + roll-up). */
  app.get("/workspaces/:wid/mission-control", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.get(wid);
  });

  /** Stop a live session (tenant-scoped). */
  app.post("/workspaces/:wid/mission-control/sessions/:id/stop", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: sessionId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const session = await getAgentSessionById(sessionId);
    if (!session || session.workspaceId !== wid) return reply.code(404).send({ error: "session not found" });
    const canceled = await sessionManager.cancel(sessionId);
    return reply.send({ canceled });
  });

  /** Steer a live session (tenant-scoped): record the redirect as a channel message, then inject it. */
  app.post("/workspaces/:wid/mission-control/sessions/:id/steer", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: sessionId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const guidance = (req.body as { guidance?: string } | undefined)?.guidance?.trim();
    if (!guidance) return reply.code(400).send({ error: "guidance required" });
    const session = await getAgentSessionById(sessionId);
    if (!session || session.workspaceId !== wid) return reply.code(404).send({ error: "session not found" });

    // The message is the source of truth (recoverable + visible); delivery is best-effort (#53).
    const message = await postMessage({
      workspaceId: wid,
      channelId: session.channelId,
      authorMemberId: id.memberId,
      body: `↪️ steering: ${guidance}`,
    });
    publishMessageEvent(session.channelId, message).catch(() => {
      /* best-effort realtime; the message is already persisted */
    });
    const delivered = await sessionManager.steer(sessionId, guidance);
    return reply.send({ delivered, messageId: message.id });
  });
}
