import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { listIncidents } from "../db/repositories/self-healing.js";

/**
 * The Self-Healing Ops surface (#193, ADR-0174): one READ-ONLY endpoint listing a workspace's
 * remediation incidents (firing / remediating / escalated / resolved, most-recent first) with the
 * breached signal, the chosen action + reversibility, the dispatched session / #13 approval refs, and
 * the self-filed postmortem ref. Tenant-scoped via the #19 guard so a caller only ever sees their own
 * incidents. No mutations: incidents open/resolve from the loop, and destructive remediation flows
 * through the #13 approvals queue — never here.
 */
export async function selfHealingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:wid/self-healing/incidents", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const query = req.query as { limit?: string };
    const limit = query.limit ? Math.min(200, Math.max(1, Number(query.limit) || 50)) : 50;
    const incidents = await listIncidents(wid, limit);
    return { incidents };
  });
}
