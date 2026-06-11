import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { listIncidents } from "../db/repositories/sre.js";

/**
 * The SRE Loop surface (#112, ADR-0112): one READ-ONLY endpoint listing a workspace's incidents
 * (firing / escalated / resolved, most-recent first) with their breached SLO, severity, triage
 * session, and drafted postmortem path. Tenant-scoped via the #19 guard (`assertWorkspace`) so a
 * caller only ever sees their own tenant's incidents. No mutations: incidents open/resolve from the
 * loop, and remediation flows through the #13 approvals queue — never here.
 */
export async function sreRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:wid/sre/incidents", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const query = req.query as { status?: string; limit?: string };
    const status =
      query.status === "firing" || query.status === "escalated" || query.status === "resolved"
        ? query.status
        : undefined;
    const limit = query.limit ? Math.min(200, Math.max(1, Number(query.limit) || 50)) : 50;
    const incidents = await listIncidents(wid, { status, limit });
    return { incidents };
  });
}
