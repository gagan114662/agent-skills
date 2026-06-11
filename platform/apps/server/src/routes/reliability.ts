import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { ackIncident, getOverlay, listPages } from "../db/repositories/reliability.js";

/**
 * The reliability surface's authenticated routes (#148, ADR-0148). Tenant-scoped via the #19 guard so a
 * caller only ever touches their own workspace.
 *
 * - POST /workspaces/:wid/reliability/incidents/:incidentId/ack — the owner acknowledges an incident,
 *   stopping the escalation re-page (sets `acked_at` on the overlay).
 * - GET  /workspaces/:wid/reliability/incidents/:incidentId — read the overlay (channel, ack, paging).
 * - GET  /workspaces/:wid/reliability/pages — the recent page audit (delivered/suppressed).
 *
 * The PUBLIC status page lives on a separate unauthenticated route (`routes/status.ts`).
 */
export async function reliabilityRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:wid/reliability/incidents/:incidentId/ack", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, incidentId } = req.params as { wid: string; incidentId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const overlay = await ackIncident(wid, incidentId, new Date());
    if (!overlay) {
      reply.code(404);
      return { error: "incident not found" };
    }
    return { ok: true, acknowledgedAt: overlay.ackedAt };
  });

  app.get("/workspaces/:wid/reliability/incidents/:incidentId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, incidentId } = req.params as { wid: string; incidentId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const overlay = await getOverlay(incidentId);
    // Tenant guard: never return another workspace's overlay even if the id is guessed.
    if (!overlay || overlay.workspaceId !== wid) {
      reply.code(404);
      return { error: "incident not found" };
    }
    return { overlay };
  });

  app.get("/workspaces/:wid/reliability/pages", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const query = req.query as { limit?: string };
    const limit = query.limit ? Math.min(200, Math.max(1, Number(query.limit) || 50)) : 50;
    return { pages: await listPages(wid, limit) };
  });
}
