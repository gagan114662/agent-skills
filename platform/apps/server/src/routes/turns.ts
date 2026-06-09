import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { addChannelMember } from "../db/repositories/channels.js";
import { grantCapability } from "../db/repositories/permissions.js";
import { getAgentSession } from "../db/repositories/agent-sessions.js";
import { listPlanProposals } from "../db/repositories/plan-proposals.js";
import { listSessionTurns } from "../db/repositories/session-turns.js";
import { postMessage } from "../db/repositories/messages.js";
import { publishMessageEvent } from "../realtime/bus.js";
import type { SessionManager } from "../runtime/manager.js";
import type { TurnController, Fail } from "../turns/controller.js";

export interface TurnRoutesOptions {
  controller: TurnController;
  sessionManager: SessionManager;
}

/** Map a controller failure result onto the HTTP reply (codes are chosen by the controller). */
function sendFail(reply: FastifyReply, fail: Fail): FastifyReply {
  return reply.code(fail.code).send({ error: fail.error });
}

/**
 * Plan mode, checkpoints & steering routes (#53, ADR-0030).
 *
 * Auth reuses the #9 channel capability ladder + the #19 tenant guard, IDOR-scoped to `:cid` exactly
 * like #25/#51: mutations (propose / decide / checkpoint / revert / steer) need `write`; lists need
 * `read`. Plan/feedback/guidance are passed to the agent only as data (`AGENT_TASK` / stdin) — never
 * argv. Checkpoint/revert return 501 when no git repo is configured (the controller decides).
 */
export async function turnRoutes(app: FastifyInstance, opts: TurnRoutesOptions): Promise<void> {
  const { controller, sessionManager } = opts;

  /** Validate that `agentMemberId` is an agent in this workspace and make it a channel writer. */
  async function prepareAgentWriter(
    workspaceId: string,
    granterMemberId: string,
    channelId: string,
    agentMemberId: string,
    reply: FastifyReply,
  ): Promise<boolean> {
    const target = await getWorkspaceMember(agentMemberId, workspaceId);
    if (!target) {
      reply.code(404).send({ error: "agent not found in this workspace" });
      return false;
    }
    if (target.kind !== "agent") {
      reply.code(400).send({ error: "agentMemberId must reference an agent member" });
      return false;
    }
    await addChannelMember(channelId, target.id);
    await grantCapability({
      workspaceId,
      memberId: target.id,
      resourceType: "channel",
      resourceId: channelId,
      capability: "write",
      grantedByMemberId: granterMemberId,
    });
    return true;
  }

  /** Load a session and assert it belongs to `:cid` (IDOR). Sends 404 + returns undefined on miss. */
  async function sessionInChannel(channelId: string, sessionId: string, reply: FastifyReply) {
    const session = await getAgentSession(sessionId, channelId);
    if (!session) {
      reply.code(404).send({ error: "session not found" });
      return undefined;
    }
    return session;
  }

  // --- plan mode ------------------------------------------------------------

  // Propose a plan: the agent runs in plan mode, proposes a plan, and WORK BLOCKS until a decision.
  app.post("/channels/:cid/plans", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    const ch = await requireChannelCapability(id, cid, "write", reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });

    const b = req.body as { agentMemberId?: string; task?: string };
    if (!b.agentMemberId) return reply.code(400).send({ error: "agentMemberId required" });
    if (!b.task) return reply.code(400).send({ error: "task required" });
    if (!(await prepareAgentWriter(id.workspaceId, id.memberId, cid, b.agentMemberId, reply))) return;

    const r = await controller.propose({
      workspaceId: id.workspaceId,
      channelId: cid,
      agentMemberId: b.agentMemberId,
      originalTask: b.task,
      createdByMemberId: id.memberId,
    });
    if (!r.ok) return sendFail(reply, r);
    return reply.code(202).send({
      proposalId: r.proposal.id,
      status: r.proposal.status,
      planText: r.proposal.planText,
      planSessionId: r.proposal.planSessionId,
    });
  });

  // List a channel's plan proposals (read).
  app.get("/channels/:cid/plans", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    return listPlanProposals(cid);
  });

  // Decide a proposed plan: approve / approve_with_feedback (launches execution) / reject.
  app.post("/channels/:cid/plans/:id/decide", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: proposalId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "write", reply))) return;

    const b = req.body as { decision?: string; feedback?: string };
    if (!b.decision) return reply.code(400).send({ error: "decision required" });

    const r = await controller.decide({
      workspaceId: id.workspaceId,
      channelId: cid,
      proposalId,
      decision: b.decision,
      feedback: b.feedback,
      decidedByMemberId: id.memberId,
    });
    if (!r.ok) return sendFail(reply, r);
    return reply.send({ status: r.status, executionSessionId: r.executionSessionId });
  });

  // --- checkpoints ----------------------------------------------------------

  // Capture a checkpoint/turn for a session (write). 201 the turn; 501 when no git repo is configured.
  app.post("/channels/:cid/agent-sessions/:id/checkpoint", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "write", reply))) return;
    if (!(await sessionInChannel(cid, sessionId, reply))) return;

    const r = await controller.checkpoint({
      workspaceId: id.workspaceId,
      channelId: cid,
      sessionId,
      createdByMemberId: id.memberId,
    });
    if (!r.ok) return sendFail(reply, r);
    return reply.code(201).send(r.turn);
  });

  // List a session's turns / checkpoints (read).
  app.get("/channels/:cid/agent-sessions/:id/turns", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    if (!(await sessionInChannel(cid, sessionId, reply))) return;
    return listSessionTurns(sessionId);
  });

  // Revert to before a turn — restores files (git reset) AND conversation (message soft-delete).
  app.post("/channels/:cid/agent-sessions/:id/turns/:turnId/revert", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: sessionId, turnId } = req.params as { cid: string; id: string; turnId: string };
    if (!(await requireChannelCapability(id, cid, "write", reply))) return;
    if (!(await sessionInChannel(cid, sessionId, reply))) return;

    const r = await controller.revert({ channelId: cid, sessionId, turnId });
    if (!r.ok) return sendFail(reply, r);
    return reply.send({
      restoreSha: r.restoreSha,
      deletedMessageCount: r.deletedMessageCount,
      discardedTurnIds: r.discardedTurnIds,
    });
  });

  // --- steering -------------------------------------------------------------

  // Steer a live session: record the guidance in the channel AND inject it into the running process.
  app.post("/channels/:cid/agent-sessions/:id/steer", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "write", reply))) return;
    const session = await sessionInChannel(cid, sessionId, reply);
    if (!session) return;

    const b = req.body as { guidance?: string };
    const guidance = b.guidance?.trim();
    if (!guidance) return reply.code(400).send({ error: "guidance required" });

    // Record the redirect in the channel as the requester (recoverable + visible), then inject it
    // into the live process. The message is the source of truth; delivery is best-effort.
    const message = await postMessage({
      workspaceId: id.workspaceId,
      channelId: cid,
      authorMemberId: id.memberId,
      body: `↪️ steering: ${guidance}`,
    });
    publishMessageEvent(cid, message).catch(() => {
      /* best-effort realtime; the message is already persisted */
    });
    const delivered = await sessionManager.steer(sessionId, guidance);
    return reply.send({ delivered, messageId: message.id });
  });
}
