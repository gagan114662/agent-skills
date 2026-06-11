import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { AuditService } from "../audit/service.js";

/**
 * Audit-trail route (#147, ADR-0147 §5) under `/workspaces/:wid/audit`. A single read endpoint over
 * the pure {@link AuditService} — tenant-scoped via the #19 `assertWorkspace` boundary, returning the
 * append-only who/what/when/gated-by feed (newest first).
 */
export interface AuditRoutesOptions {
  service: AuditService;
}

export async function auditRoutes(app: FastifyInstance, opts: AuditRoutesOptions): Promise<void> {
  app.get("/workspaces/:wid/audit", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const limit = Number((req.query as { limit?: string }).limit ?? 200) || 200;
    return opts.service.get(wid, Math.min(500, Math.max(1, limit)));
  });
}
