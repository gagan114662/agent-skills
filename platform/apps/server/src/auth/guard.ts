import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveIdentity } from "./middleware.js";
import type { Identity } from "./identity.js";

/**
 * Centralized auth + tenant guards (#19), carrying forward the #3 IDOR discipline.
 *
 * Routes repeat two checks: "is the caller authenticated?" and "does the caller's
 * workspace match the resource's workspace?". Centralizing them here means no route
 * can silently forget the cross-tenant check — and the cross-tenant leakage
 * integration test is the regression guard.
 *
 * Both helpers send the error response themselves and return `undefined` on failure,
 * so call sites read: `const id = await requireIdentity(req, reply); if (!id) return;`
 */

/** Resolve the caller or send 401. Returns the identity, or undefined (response sent). */
export async function requireIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<Identity | undefined> {
  const identity = await resolveIdentity(req);
  if (!identity) {
    await reply.code(401).send({ error: "unauthorized" });
    return undefined;
  }
  return identity;
}

/**
 * Assert the caller belongs to `workspaceId` or send 403. Returns true on success.
 * This is the workspace-boundary check every tenant-scoped route must apply.
 */
export function assertWorkspace(
  identity: Identity,
  workspaceId: string,
  reply: FastifyReply,
): boolean {
  if (identity.workspaceId !== workspaceId) {
    void reply.code(403).send({ error: "wrong workspace" });
    return false;
  }
  return true;
}
