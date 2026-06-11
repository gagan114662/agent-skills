import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { SemanticLayerService } from "../semantic/service.js";

/**
 * Semantic layer routes (#155, ADR-0155 §2–3) under `/workspaces/:wid/semantic`. Thin adapters over
 * {@link SemanticLayerService} — identity + the #19 `assertWorkspace` IDOR boundary, then a single service
 * call. The catalog + every metric answer are reads (always-on, tenant-scoped); answers carry their
 * provenance path + freshness so the caller can see whether they got the canonical number or a flagged
 * fallback. Lens consumes these; no number is invented in the route.
 */
export interface SemanticRoutesOptions {
  service: SemanticLayerService;
}

export async function semanticRoutes(app: FastifyInstance, opts: SemanticRoutesOptions): Promise<void> {
  const { service } = opts;

  /** The metric catalog (definitions) + every canonical answer for this workspace. */
  app.get("/workspaces/:wid/semantic/metrics", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const answers = await service.answerAll(wid);
    return { catalog: service.catalog(), answers };
  });

  /** One canonical metric answer (the one-number-everywhere path), provenance + freshness flagged. */
  app.get("/workspaces/:wid/semantic/metrics/:metricId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, metricId } = req.params as { wid: string; metricId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const answer = await service.answer(wid, metricId);
    if (!answer) return reply.code(404).send({ error: `unknown metric: ${metricId}` });
    return answer;
  });
}
