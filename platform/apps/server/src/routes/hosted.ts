import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { buildHostedPublishService, hostedFlagsFor } from "../hosted/default.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #266 hosted-publishing routes. The `/me/hosted/*` surface is `/me`-scoped to the caller's workspace
 * (#3) and gated default-OFF (owner-workspace-first). The HARD constraint is structural: a page is only
 * ever DRAFTED here and `POST /publish` only PARKS a #13 approval — nothing goes live without the owner
 * approving in the decision queue. The public serve route (`GET /hosted/p/:slug`) resolves the requesting
 * Host to a site and returns only a `published` page's bytes, recording a real view receipt.
 */
export async function hostedRoutes(app: FastifyInstance): Promise<void> {
  const service = buildHostedPublishService();

  app.get("/me/hosted", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const [summary, pages] = await Promise.all([service.summary(wid), service.listPages(wid, 50)]);
    return { ...summary, pages };
  });

  /** Draft a page (validate + render + store). Autonomous — a draft is invisible until owner-approved. */
  app.post("/me/hosted/pages", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    if (!hostedFlagsFor(wid).enabled) {
      return reply.code(403).send({ error: "hosted publishing is disabled for this workspace" });
    }
    const body = (req.body ?? {}) as {
      title?: string;
      body?: string;
      kind?: string;
      slug?: string;
      description?: string;
    };
    if (!body.title || !body.body) {
      return reply.code(400).send({ error: "title and body are required" });
    }
    const result = await service.draftPage({
      workspaceId: wid,
      title: body.title,
      body: body.body,
      kind: body.kind,
      slug: body.slug,
      description: body.description,
    });
    if (result.status === "disabled") {
      return reply.code(403).send({ error: "hosted publishing is disabled for this workspace" });
    }
    if (result.status === "rejected") return reply.code(400).send({ error: result.reason });
    return reply.code(201).send({ page: result.page });
  });

  /** Request that a drafted page go live — PARKS a #13 approval (never publishes autonomously). */
  app.post("/me/hosted/pages/:id/publish", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: "invalid page id" });
    const result = await service.requestPublish({
      workspaceId: wid,
      pageId: id,
      requesterMemberId: identity.memberId,
    });
    if (result.status === "disabled") {
      return reply.code(403).send({ error: "hosted publishing is disabled for this workspace" });
    }
    if (result.status === "not_found") return reply.code(404).send({ error: "page not found" });
    if (result.status === "rejected") return reply.code(409).send({ error: result.reason });
    return reply.code(202).send(result);
  });

  /** Reversible take-down of a published page (#200 §4). */
  app.post("/me/hosted/pages/:id/unpublish", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: "invalid page id" });
    const result = await service.unpublish({ workspaceId: wid, pageId: id });
    if (result.status === "not_found") return reply.code(404).send({ error: "page not found" });
    return result;
  });

  /**
   * Public serve. In production the customer's domain (or ipop subdomain) fronts this; here the requesting
   * Host header selects the tenant. Only a `published` page is served — everything else is a 404.
   */
  app.get("/hosted/p/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const host = req.hostname;
    const served = await service.serve(host, slug, { referrer: req.headers.referer ?? null });
    if (!served) return reply.code(404).send({ error: "not found" });
    return reply.type("text/html; charset=utf-8").send(served.html);
  });
}
