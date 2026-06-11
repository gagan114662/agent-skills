import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { listVerifierResults } from "../db/repositories/verifier-results.js";
import { isVerifierKind, VERIFIER_STATUSES, type VerifierStatus } from "../verifiers/types.js";

/**
 * The Outcome Verifiers surface (#106, ADR-0106): one READ-ONLY endpoint listing a workspace's durable
 * verification verdicts (passed / failed / errored, most-recent first), optionally filtered by kind or
 * status. Tenant-scoped via the #19 guard (`assertWorkspace`) so a caller only ever sees their own
 * tenant's evidence. No mutations: verdicts are written by the runner on infrastructure time, and a
 * failed gate's remediation flows through the #13 approvals queue — never here.
 */
export async function verifierRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:wid/verifier-results", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const query = req.query as { kind?: string; status?: string; limit?: string };
    const kind = query.kind && isVerifierKind(query.kind) ? query.kind : undefined;
    const status =
      query.status && (VERIFIER_STATUSES as readonly string[]).includes(query.status)
        ? (query.status as VerifierStatus)
        : undefined;
    const limit = query.limit ? Math.min(200, Math.max(1, Number(query.limit) || 50)) : 50;
    const results = await listVerifierResults(wid, { kind, status, limit });
    return { results };
  });
}
