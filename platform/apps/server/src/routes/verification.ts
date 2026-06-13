import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { listVerdicts, latestDefinition } from "../db/repositories/verification.js";
import { VERIFICATION_VERDICT_STATUSES } from "../db/schema/verification.js";
import type { VerificationVerdictRecord } from "../verification/types.js";

/**
 * The Deliverable Verification Layer surface (#191, ADR-0191) — READ-ONLY proof. Two endpoints, both
 * tenant-scoped via the #19 guard so a caller only ever sees their own tenant's evidence:
 *
 *   - `GET /workspaces/:wid/verification/verdicts` lists the durable verdicts (the per-check proof shown
 *     on the approval cards), most-recent first, optionally filtered by deliverable or status.
 *   - `GET /workspaces/:wid/verification/criteria/:ref` returns the latest definition of done for a
 *     deliverable (the "done defined before doing" spec — #191 AC #1, visible).
 *
 * No mutations: verdicts are written by the engine at the deliverable chokepoint, and remediation flows
 * through the #13 approvals queue — never here.
 */
export async function verificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:wid/verification/verdicts", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const query = req.query as { deliverableRef?: string; status?: string; limit?: string };
    const status =
      query.status && (VERIFICATION_VERDICT_STATUSES as readonly string[]).includes(query.status)
        ? (query.status as VerificationVerdictRecord["status"])
        : undefined;
    const limit = query.limit ? Math.min(200, Math.max(1, Number(query.limit) || 50)) : 50;
    const verdicts = await listVerdicts(wid, { deliverableRef: query.deliverableRef, status, limit });
    return { verdicts };
  });

  app.get("/workspaces/:wid/verification/criteria/:ref", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, ref } = req.params as { wid: string; ref: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const definition = await latestDefinition(wid, ref);
    if (!definition) return reply.code(404).send({ error: "no definition of done for this deliverable" });
    return { definition };
  });
}
