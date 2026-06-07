import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { effectiveCapability, type Capability } from "../auth/access.js";
import { listChannels, isChannelMember, type Channel } from "../db/repositories/channels.js";
import { getCapability } from "../db/repositories/permissions.js";
import { buildOpenApiDocument } from "../agent-interface/openapi.js";

/**
 * #11 — the framework-agnostic agent interface. This module is intentionally thin: the agent
 * surface is composed almost entirely of endpoints that already exist (#3 `/me` + `/me/mentions`,
 * #4 channel messages, #9 RBAC). It adds only the one genuinely-new convenience endpoint —
 * "which channels can *I* use?" — plus the published OpenAPI contract. No new authority, no new
 * table: it reuses the exact identity/capability helpers the human-facing routes already trust.
 */

/** A channel the caller can access, annotated with the caller's effective capability (#9). */
export interface AccessibleChannel extends Channel {
  capability: Capability;
}

export async function agentInterfaceRoutes(app: FastifyInstance): Promise<void> {
  // The channels in the caller's workspace they can actually access (effective capability ≥ read),
  // each annotated with that capability. Unlike `GET /workspaces/:wid/channels` (which lists every
  // channel in the workspace), this answers "what can *I* use?" — workspace-scoped (#3) and
  // capability-filtered (#9), so it never leaks a channel the caller can't access.
  app.get("/me/channels", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const all = await listChannels(identity.workspaceId);
    const accessible: AccessibleChannel[] = [];
    for (const ch of all) {
      const isMember = await isChannelMember(ch.id, identity.memberId);
      const explicit = await getCapability(identity.workspaceId, identity.memberId, "channel", ch.id);
      const capability = effectiveCapability(explicit, isMember);
      if (capability) accessible.push({ ...ch, capability });
    }
    return accessible;
  });

  // The published agent contract (OpenAPI 3.1). Public on purpose: a static document with no
  // tenant data, so an external author can read the interface before they have a token.
  app.get("/openapi.json", async (_req, reply) => {
    void reply.header("content-type", "application/json; charset=utf-8");
    return buildOpenApiDocument();
  });
}
