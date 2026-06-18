import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { buildSocialPublishService, socialFlagsFor } from "../social/default.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #269 Echo social-posting routes. The `/me/social/*` surface is `/me`-scoped to the caller's workspace
 * (#3) and gated default-OFF (owner-workspace-first). The HARD constraint is structural: a post is only
 * ever DRAFTED here and `POST /publish` only PARKS a #13 approval — nothing fans out to a network without
 * the owner approving in the decision queue (a post is irreversible). The aggregator is the dry-run default,
 * so nothing posts for real until an owner connects a live aggregator.
 */
export async function socialRoutes(app: FastifyInstance): Promise<void> {
  const service = buildSocialPublishService();

  app.get("/me/social", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const [summary, posts] = await Promise.all([service.summary(wid), service.listPosts(wid, 50)]);
    return { ...summary, posts };
  });

  /** Draft a post (validate + store + return the per-network preview). Autonomous — a draft posts nothing. */
  app.post("/me/social/posts", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    if (!socialFlagsFor(wid).enabled) {
      return reply.code(403).send({ error: "social posting is disabled for this workspace" });
    }
    const body = (req.body ?? {}) as { body?: string; networks?: unknown; scheduledAt?: string | null };
    if (!body.body || !Array.isArray(body.networks)) {
      return reply.code(400).send({ error: "body and networks[] are required" });
    }
    const result = await service.draftPost({
      workspaceId: wid,
      body: body.body,
      networks: body.networks.map(String),
      scheduledAt: body.scheduledAt ?? null,
    });
    if (result.status === "disabled") {
      return reply.code(403).send({ error: "social posting is disabled for this workspace" });
    }
    if (result.status === "rejected") return reply.code(400).send({ error: result.reason });
    return reply.code(201).send({ post: result.post, previews: result.previews });
  });

  /** Preview a candidate post per-network WITHOUT storing it (pure). */
  app.post("/me/social/preview", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const body = (req.body ?? {}) as { body?: string; networks?: unknown; scheduledAt?: string | null };
    if (!body.body || !Array.isArray(body.networks)) {
      return reply.code(400).send({ error: "body and networks[] are required" });
    }
    const result = service.previewPost({
      workspaceId: wid,
      body: body.body,
      networks: body.networks.map(String),
      scheduledAt: body.scheduledAt ?? null,
    });
    if (result.status === "disabled") {
      return reply.code(403).send({ error: "social posting is disabled for this workspace" });
    }
    if (result.status === "rejected") return reply.code(400).send({ error: result.reason });
    return { previews: result.previews };
  });

  /** Request that a drafted post fan out — PARKS a #13 approval (never posts autonomously). */
  app.post("/me/social/posts/:id/publish", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: "invalid post id" });
    const result = await service.requestPublish({
      workspaceId: wid,
      postId: id,
      requesterMemberId: identity.memberId,
    });
    if (result.status === "disabled") {
      return reply.code(403).send({ error: "social posting is disabled for this workspace" });
    }
    if (result.status === "not_found") return reply.code(404).send({ error: "post not found" });
    if (result.status === "rejected") return reply.code(409).send({ error: result.reason });
    return reply.code(202).send(result);
  });
}
