import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { createDefaultGardenService } from "../garden/default.js";

/**
 * Agent Garden routes (#284, ADR-0284) — the customer-facing console surface that browses the department
 * fleet (reading the #282 registry contracts) and enables/disables each agent per workspace. All
 * `/me/*`-scoped to the caller's workspace (#3, the httpOnly `rid` session cookie identifies it).
 *
 *  - `GET  /me/garden` — the catalog: every fleet agent's (sanitized) contract + cost/risk tier + this
 *    workspace's enable state + the production-grounded `active` flag. Read-only; works regardless of the
 *    flag (`canManage` reflects it). Browse is always allowed.
 *  - `POST /me/garden/:handle/enable` — switch an agent on. A read-only / internal-draft agent enables
 *    directly; an `external_send` (irreversible-action) agent parks a PENDING `garden.enable_agent` #13
 *    request (default OFF, owner approves in the decision queue). 404 unknown handle, 409 out-of-scope.
 *  - `POST /me/garden/:handle/disable` — switch an agent off (always immediate; only reduces blast radius).
 *
 * Human-auth + workspace-scoped. The surface is default-OFF and owner-workspace-first: when the flag is off
 * the catalog still lists but every enable/disable 409s, so a deployment that sets nothing changes nothing.
 */
export async function gardenRoutes(app: FastifyInstance): Promise<void> {
  const service = createDefaultGardenService();

  // The catalog + per-workspace enable state. Read-only; never a secret.
  app.get("/me/garden", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.list({ workspaceId: id.workspaceId, memberId: id.memberId });
  });

  // Switch an agent on. An external-send agent parks an owner approval (202) instead of enabling directly.
  app.post("/me/garden/:handle/enable", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    if (id.kind !== "human") return reply.code(401).send({ error: "human authentication required" });
    const { handle } = req.params as { handle: string };
    const result = await service.enable({ workspaceId: id.workspaceId, memberId: id.memberId }, handle);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return reply
      .code(result.outcome === "pending_approval" ? 202 : 200)
      .send(
        result.outcome === "pending_approval"
          ? { outcome: result.outcome, requestId: result.requestId, garden: result.view }
          : { outcome: result.outcome, garden: result.view },
      );
  });

  // Switch an agent off. Always immediate (a disable is never gated — it only reduces blast radius).
  app.post("/me/garden/:handle/disable", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    if (id.kind !== "human") return reply.code(401).send({ error: "human authentication required" });
    const { handle } = req.params as { handle: string };
    const result = await service.disable({ workspaceId: id.workspaceId, memberId: id.memberId }, handle);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return reply.code(200).send({ outcome: result.outcome, garden: result.view });
  });
}
