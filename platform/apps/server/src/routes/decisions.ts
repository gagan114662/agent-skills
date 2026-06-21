import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireMemoryCapability, requireTaskInWorkspace } from "../auth/access.js";
import type { Identity } from "../auth/identity.js";
import { createDefaultDecisionService } from "../decisions/default.js";
import type { RecordDecisionRequest } from "../decisions/types.js";

/**
 * Shared decision-store routes (issue #513) — the system of record that lets agents capture decisions and
 * reuse the ones their teammates made before. RBAC reuses the #16 memory ladder (`requireMemoryCapability`
 * on the `memory` resource): read to browse/recall, write to record/supersede — so a decision is governed
 * exactly like the graph it mirrors into. Every route is workspace-scoped (#3 IDOR). The service sanitizes
 * all user-facing fields (no internal agent chatter, #200) and parks any external/money action behind the
 * #13 gate; routes stay thin.
 */
export async function decisionsRoutes(app: FastifyInstance): Promise<void> {
  const service = createDefaultDecisionService();

  /** Parse + validate the shared record/supersede body. Returns the request, or sends a 400 and null. */
  async function parseBody(
    req: FastifyRequest,
    reply: FastifyReply,
    identity: Identity,
    wid: string,
  ): Promise<RecordDecisionRequest | null> {
    const b = req.body as {
      topic?: string;
      title?: string;
      rationale?: string;
      taskId?: string;
      external?: { actionType?: string; amount?: number | null; summary?: string; payload?: Record<string, unknown> };
    };
    if (!b.topic || !b.title || !b.rationale) {
      reply.code(400).send({ error: "topic, title and rationale required" });
      return null;
    }
    // A linked task must live in this workspace (IDOR): validate before recording.
    if (b.taskId) {
      const task = await requireTaskInWorkspace(identity, b.taskId, reply);
      if (!task) return null;
    }
    let external: RecordDecisionRequest["external"] = null;
    if (b.external) {
      if (!b.external.actionType || !b.external.summary) {
        reply.code(400).send({ error: "external.actionType and external.summary required" });
        return null;
      }
      external = {
        actionType: b.external.actionType,
        amount: typeof b.external.amount === "number" ? b.external.amount : null,
        summary: b.external.summary,
        payload: b.external.payload ?? {},
      };
    }
    return {
      workspaceId: wid,
      decidedByMemberId: identity.memberId,
      topic: b.topic,
      title: b.title,
      rationale: b.rationale,
      taskId: b.taskId ?? null,
      external,
    };
  }

  // record a decision; dedup → 201 new / 200 merged-into-existing. An external/money decision is recorded
  // but its action is parked PENDING behind the #13 gate (`pendingApproval: true`).
  app.post("/workspaces/:wid/decisions", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "write", reply))) return;
    const body = await parseBody(req, reply, id, wid);
    if (!body) return;
    const decision = await service.record(body);
    return reply.code(decision.created ? 201 : 200).send(decision);
  });

  // browse decisions; ?topic= filters, ?includeSuperseded=true surfaces version history (excluded by default).
  app.get("/workspaces/:wid/decisions", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const q = req.query as { topic?: string; includeSuperseded?: string; limit?: string };
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return service.list(wid, {
      topic: q.topic,
      includeSuperseded: q.includeSuperseded === "true",
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  });

  // recall the prior decisions an agent should reuse before deciding (rows + a chatter-free brief).
  app.get("/workspaces/:wid/decisions/recall", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const q = req.query as { topic?: string; limit?: string };
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return service.recall(wid, { topic: q.topic, limit: Number.isFinite(limit) ? limit : undefined });
  });

  // supersede an existing decision with a newer one: marks the old stale (kept), records the new call.
  app.post("/workspaces/:wid/decisions/:id/supersede", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: oldId } = req.params as { wid: string; id: string };
    if (!(await requireMemoryCapability(id, wid, "write", reply))) return;
    const old = await service.get(wid, oldId);
    if (!old) {
      return reply.code(404).send({ error: "decision not found in this workspace" });
    }
    const body = await parseBody(req, reply, id, wid);
    if (!body) return;
    const result = await service.supersede(oldId, body);
    return reply.code(result.created ? 201 : 200).send(result);
  });
}
