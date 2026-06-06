import type { FastifyRequest } from "fastify";
import type { Identity } from "./identity.js";
import { hashToken, AGENT_TOKEN_PREFIX } from "./secrets.js";
import {
  findValidAgentToken,
  getAgentMember,
  findValidSession,
  getHumanMember,
} from "../db/repositories/auth.js";

export const SESSION_COOKIE = "rid";

/**
 * Resolve the caller to a workspace member, or null if unauthenticated.
 * Priority: agent Bearer token, then human session cookie. Shared by HTTP routes
 * and (later, #5) the WebSocket gateway.
 */
export async function resolveIdentity(req: FastifyRequest): Promise<Identity | null> {
  const authz = req.headers.authorization;
  if (authz?.startsWith("Bearer ")) {
    const raw = authz.slice("Bearer ".length).trim();
    if (!raw.startsWith(AGENT_TOKEN_PREFIX)) return null;
    const tok = await findValidAgentToken(hashToken(raw));
    if (!tok) return null;
    const member = await getAgentMember(tok.agentId, tok.workspaceId);
    if (!member) return null;
    return {
      workspaceId: tok.workspaceId,
      memberId: member.id,
      kind: "agent",
      displayName: member.displayName,
    };
  }

  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) {
    const sess = await findValidSession(hashToken(cookie));
    if (!sess) return null;
    const member = await getHumanMember(sess.userId);
    if (!member) return null;
    return {
      workspaceId: member.workspaceId,
      memberId: member.id,
      kind: "human",
      displayName: member.displayName,
    };
  }

  return null;
}
