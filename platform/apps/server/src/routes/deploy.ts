import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DeploymentDto } from "@reload/shared";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getAgentSession, type AgentSession } from "../db/repositories/agent-sessions.js";
import type { Deployment } from "../db/repositories/deployments.js";
import {
  DeployEgressBlocked,
  NoDeployConfigError,
  NoRollbackTargetError,
  type DeployManager,
} from "../deploy/manager.js";

export interface DeployRoutesOptions {
  deployManager: DeployManager;
}

/**
 * Deploy routes (#73): take a session's app to a live HTTPS URL, redeploy, read status/history, roll
 * back to a prior good deploy, and scale — all through the `DeployProvider` adapter.
 *
 * Every route is gated by **channel write capability** (deploying/scaling/rolling back are writes) and
 * resolves the session **scoped to its channel** (`getAgentSession(id, cid)`) so it is IDOR-safe. The
 * deploy command/config is never request-supplied — it comes from trusted layered config (#58), the
 * same trust boundary as the #56 run command; the request body carries only a bounded `reason`/scale.
 */
export async function deployRoutes(app: FastifyInstance, opts: DeployRoutesOptions): Promise<void> {
  const { deployManager } = opts;

  async function authorize(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{
    workspaceId: string;
    memberId: string;
    cid: string;
    sessionId: string;
    session: AgentSession;
  } | null> {
    const id = await requireIdentity(req, reply);
    if (!id) return null;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "write", reply))) return null;
    const session = await getAgentSession(sessionId, cid);
    if (!session) {
      reply.code(404).send({ error: "session not found" });
      return null;
    }
    return { workspaceId: id.workspaceId, memberId: id.memberId, cid, sessionId, session };
  }

  /** Map a deployment row to the web-facing DTO (drops server-only fields). */
  function toDto(d: Deployment): DeploymentDto {
    return {
      id: d.id,
      sessionId: d.sessionId,
      channelId: d.channelId,
      provider: d.provider,
      status: d.status,
      url: d.url,
      framework: d.framework,
      error: d.error,
      reason: d.reason,
      rolledBackFromId: d.rolledBackFromId,
      logs: d.logs,
      createdAt: d.createdAt.toISOString(),
    };
  }

  /** Map the deploy/rollback errors onto HTTP, or rethrow anything unexpected. */
  function mapError(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof NoDeployConfigError) return reply.code(409).send({ error: "deploy not enabled" });
    if (err instanceof DeployEgressBlocked) {
      return reply.code(409).send({ error: "deploy blocked by data-privacy mode" });
    }
    if (err instanceof NoRollbackTargetError) {
      return reply.code(409).send({ error: "no prior deployment to roll back to" });
    }
    throw err;
  }

  // Start a deploy (or redeploy — each call is a new immutable deployment).
  app.post("/channels/:cid/agent-sessions/:id/deploy", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;
    const reason = parseReason((req.body as { reason?: unknown } | undefined)?.reason);
    try {
      const deployment = await deployManager.deploy({
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        channelId: ctx.cid,
        agentMemberId: ctx.session.agentMemberId,
        createdByMemberId: ctx.memberId,
        reason,
      });
      return reply.code(202).send(toDto(deployment));
    } catch (err) {
      return mapError(err, reply);
    }
  });

  // Latest deployment state (status + url + redacted log tail).
  app.get("/channels/:cid/agent-sessions/:id/deploy", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;
    const latest = await deployManager.get(ctx.sessionId, ctx.cid);
    if (!latest) return reply.code(404).send({ error: "no deployment" });
    return toDto(latest);
  });

  // Deployment history for the session, newest first (the backup set).
  app.get("/channels/:cid/agent-sessions/:id/deploy/history", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;
    const rows = await deployManager.list(ctx.sessionId, ctx.cid);
    return rows.map(toDto);
  });

  // Roll back to the prior good deployment.
  app.post("/channels/:cid/agent-sessions/:id/deploy/rollback", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;
    try {
      const deployment = await deployManager.rollback({
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        channelId: ctx.cid,
        agentMemberId: ctx.session.agentMemberId,
        createdByMemberId: ctx.memberId,
      });
      return reply.code(202).send(toDto(deployment));
    } catch (err) {
      return mapError(err, reply);
    }
  });

  // One-click scaling (bounded to the configured maxInstances by the manager).
  app.post("/channels/:cid/agent-sessions/:id/deploy/scale", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;
    const body = (req.body ?? {}) as { instances?: unknown; size?: unknown };
    const instances = parseInstances(body.instances);
    const size = typeof body.size === "string" && body.size.length <= 32 ? body.size : undefined;
    const latest = await deployManager.get(ctx.sessionId, ctx.cid);
    if (!latest) return reply.code(404).send({ error: "no deployment" });
    await deployManager.scale(latest, { instances, size });
    return { ok: true };
  });
}

const MAX_REASON_LEN = 200;

/** A bounded `reason` string (it lands in a row + the channel message); undefined when absent/oversized. */
function parseReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_REASON_LEN) return undefined;
  return trimmed;
}

/** A positive instance count (further clamped to maxInstances by the manager); undefined otherwise. */
function parseInstances(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 1000) return undefined;
  return raw;
}
