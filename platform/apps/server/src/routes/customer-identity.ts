import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { resolveCustomerIdentity } from "../identity/customer-identity.js";

/**
 * Customer-facing identity read surface (#389, ADR-0389) under `/me/customer-identity`, scoped to the
 * caller's workspace (#3, the httpOnly `rid` session cookie identifies it). Returns the sanitized "face
 * that sells" the fleet PRESENTS on customer-facing comms: display name + avatar + optional voice profile.
 *
 * IDENTITY/DISPLAY ONLY — reading this resolves the presented identity; it authorizes NO send. Every real
 * outbound send/publish still flows through the #13 gate and the existing connectors. Read-only, no money.
 *
 * Caps-gated (default OFF, owner-workspace-first): when the identity is not active for the workspace the
 * endpoint answers `409` — the surface is opt-in, mirroring the attribution route. The resolver fails
 * closed (off / named-nobody / non-owner ⇒ no identity), so a deployment that sets nothing changes nothing.
 */
export async function customerIdentityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/customer-identity", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const identity = resolveCustomerIdentity(
      loadConfig(id.workspaceId).customerIdentity,
      id.workspaceId,
    );
    if (!identity) {
      return reply
        .code(409)
        .send({ error: "customer-facing identity is not enabled for this workspace" });
    }
    return { identity };
  });
}
