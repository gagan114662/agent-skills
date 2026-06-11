import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import {
  listMentionsForMember,
  countMentionsForMember,
} from "../db/repositories/mentions.js";
import {
  getCredentialStatus,
  setWorkspaceClaudeToken,
  clearWorkspaceClaudeToken,
} from "../db/repositories/agent-credentials.js";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return identity;
  });

  // The caller's @mentions in their workspace, newest first (#6).
  app.get("/me/mentions", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return listMentionsForMember(identity.workspaceId, identity.memberId);
  });

  // How many times the caller has been mentioned in their workspace (#6).
  app.get("/me/mentions/count", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return { count: await countMentionsForMember(identity.workspaceId, identity.memberId) };
  });

  // --- Settings → Connect Claude (#68): the per-tenant subscription credential vault. ---

  // The connected/not-connected state for the Connect Claude panel. NEVER returns the token itself.
  app.get("/me/agent-credentials", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return getCredentialStatus(identity.workspaceId);
  });

  // Connect (or re-connect) the workspace's Claude subscription token (`claude setup-token`). The
  // token is write-only — stored sealed in the vault and never echoed back; only the connected state
  // + fingerprint are returned.
  app.put("/me/agent-credentials", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const body = (req.body ?? {}) as { token?: unknown };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      return reply.code(400).send({ error: "token required" });
    }
    return setWorkspaceClaudeToken({
      workspaceId: identity.workspaceId,
      token,
      connectedByMemberId: identity.memberId,
    });
  });

  // Disconnect the workspace's Claude subscription (idempotent).
  app.delete("/me/agent-credentials", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    await clearWorkspaceClaudeToken(identity.workspaceId);
    return { connected: false, fingerprint: null, connectedAt: null };
  });
}
