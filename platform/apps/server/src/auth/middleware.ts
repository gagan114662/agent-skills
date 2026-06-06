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
 * Raw credentials a caller can present, decoupled from the HTTP transport. Lets the
 * WebSocket gateway (#5) reuse the exact same identity resolution as REST routes,
 * sourcing credentials from the upgrade request (headers, cookie, or query param).
 */
export interface Credentials {
  /** `Authorization` header value, e.g. `Bearer reload_…` (agents). */
  authorization?: string | undefined;
  /** Raw session token from the `rid` cookie (humans). */
  sessionToken?: string | undefined;
}

/**
 * Resolve raw credentials to a workspace member, or null if unauthenticated.
 * Priority: agent Bearer token, then human session token. The single source of
 * truth for both REST (`resolveIdentity`) and the #5 WebSocket gateway.
 */
export async function resolveIdentityFromCredentials(
  creds: Credentials,
): Promise<Identity | null> {
  const authz = creds.authorization;
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

  const token = creds.sessionToken;
  if (token) {
    const sess = await findValidSession(hashToken(token));
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

/**
 * Resolve the caller to a workspace member, or null if unauthenticated.
 * Priority: agent Bearer token, then human session cookie.
 */
export async function resolveIdentity(req: FastifyRequest): Promise<Identity | null> {
  return resolveIdentityFromCredentials({
    authorization: req.headers.authorization,
    sessionToken: req.cookies?.[SESSION_COOKIE],
  });
}
