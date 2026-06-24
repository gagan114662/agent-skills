import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, getPool } from "../index.js";
import { users, agents, members, sessions, agentTokens } from "../schema/index.js";

// --- humans -------------------------------------------------------------

export async function findUserByEmail(
  email: string,
): Promise<{ id: string; passwordHash: string | null; displayName: string } | undefined> {
  const [row] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, displayName: users.displayName })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row;
}

/** Create a human user (with password) + their member row in a workspace. */
export async function createHumanAccount(input: {
  workspaceId: string;
  email: string;
  passwordHash: string;
  displayName: string;
}): Promise<{ userId: string; memberId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: input.email, passwordHash: input.passwordHash, displayName: input.displayName })
    .returning({ id: users.id });
  const [member] = await db
    .insert(members)
    .values({
      workspaceId: input.workspaceId,
      kind: "human",
      userId: user!.id,
      displayName: input.displayName,
    })
    .returning({ id: members.id });
  return { userId: user!.id, memberId: member!.id };
}

/**
 * Create an OAuth-only human (no password) + their member row in a workspace (#260). Mirrors
 * {@link createHumanAccount} but leaves `password_hash` NULL — the existing login path already refuses a
 * password login for such a user (`!user.passwordHash`), so the account is reachable only via OAuth.
 */
export async function createOAuthHumanAccount(input: {
  workspaceId: string;
  email: string;
  displayName: string;
}): Promise<{ userId: string; memberId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: input.email, passwordHash: null, displayName: input.displayName })
    .returning({ id: users.id });
  const [member] = await db
    .insert(members)
    .values({
      workspaceId: input.workspaceId,
      kind: "human",
      userId: user!.id,
      displayName: input.displayName,
    })
    .returning({ id: members.id });
  return { userId: user!.id, memberId: member!.id };
}

/** The human's member (first membership) — used to resolve identity for /me. */
export async function getHumanMember(
  userId: string,
): Promise<{ id: string; workspaceId: string; displayName: string } | undefined> {
  const [row] = await db
    .select({ id: members.id, workspaceId: members.workspaceId, displayName: members.displayName })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.kind, "human")))
    .limit(1);
  return row;
}

// --- sessions -----------------------------------------------------------

export async function createSession(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(sessions).values(input);
}

export async function findValidSession(
  tokenHash: string,
): Promise<{ userId: string } | undefined> {
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row;
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export async function deleteExpiredSessions(input: { now: Date; limit: number }): Promise<number> {
  const limit = Math.max(0, Math.trunc(input.limit));
  if (limit <= 0) return 0;
  const res = await getPool().query<{ id: string }>(
    `WITH doomed AS (
       SELECT id
         FROM sessions
        WHERE expires_at <= $1
        ORDER BY expires_at ASC
        LIMIT $2
     )
     DELETE FROM sessions
      USING doomed
      WHERE sessions.id = doomed.id
      RETURNING sessions.id`,
    [input.now, limit],
  );
  return res.rowCount ?? res.rows.length;
}

// --- agents -------------------------------------------------------------

/** Create an agent + its member + an API token (returns nothing; caller holds the raw token). */
export async function createAgentWithToken(input: {
  workspaceId: string;
  name: string;
  framework?: string;
  ownerUserId?: string;
  tokenHash: string;
}): Promise<{ agentId: string; memberId: string; tokenId: string }> {
  const [agent] = await db
    .insert(agents)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      framework: input.framework ?? null,
      ownerUserId: input.ownerUserId ?? null,
    })
    .returning({ id: agents.id });
  const [member] = await db
    .insert(members)
    .values({
      workspaceId: input.workspaceId,
      kind: "agent",
      agentId: agent!.id,
      displayName: input.name,
    })
    .returning({ id: members.id });
  const [token] = await db
    .insert(agentTokens)
    .values({
      agentId: agent!.id,
      workspaceId: input.workspaceId,
      tokenHash: input.tokenHash,
      name: input.name,
    })
    .returning({ id: agentTokens.id });
  return { agentId: agent!.id, memberId: member!.id, tokenId: token!.id };
}

export async function findValidAgentToken(
  tokenHash: string,
): Promise<{ agentId: string; workspaceId: string } | undefined> {
  const [row] = await db
    .select({ agentId: agentTokens.agentId, workspaceId: agentTokens.workspaceId })
    .from(agentTokens)
    .where(and(eq(agentTokens.tokenHash, tokenHash), isNull(agentTokens.revokedAt)))
    .limit(1);
  return row;
}

/**
 * Revoke a token, scoped to the caller's workspace (prevents cross-tenant revoke / IDOR).
 * Returns false if the token does not exist *in that workspace*.
 */
export async function revokeAgentToken(tokenId: string, workspaceId: string): Promise<boolean> {
  const res = await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.workspaceId, workspaceId)))
    .returning({ id: agentTokens.id });
  return res.length > 0;
}

/** The agent's member, but only while the agent is active — a deactivated agent (#9) resolves to nothing. */
export async function getAgentMember(
  agentId: string,
  workspaceId: string,
): Promise<{ id: string; displayName: string } | undefined> {
  const [row] = await db
    .select({ id: members.id, displayName: members.displayName })
    .from(members)
    .innerJoin(agents, eq(agents.id, members.agentId))
    .where(
      and(
        eq(members.agentId, agentId),
        eq(members.workspaceId, workspaceId),
        isNull(agents.deactivatedAt),
      ),
    )
    .limit(1);
  return row;
}

/**
 * A single agent profile, workspace-scoped (#3 IDOR): an agent id from another workspace resolves
 * to nothing. Used by the A2A adapter to derive an AgentCard (#12).
 */
export async function getAgentById(
  agentId: string,
  workspaceId: string,
): Promise<{ id: string; name: string; framework: string | null; deactivatedAt: Date | null } | undefined> {
  const [row] = await db
    .select({
      id: agents.id,
      name: agents.name,
      framework: agents.framework,
      deactivatedAt: agents.deactivatedAt,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  return row;
}

/**
 * Resolve an active agent member by its handle (display name, case-insensitive) within a workspace.
 * Used by the ACP adapter to map a run's `agent_name` to a member (#12). Deactivated agents resolve
 * to nothing (their member row is gone via the same active-only join as {@link getAgentMember}).
 */
export async function getAgentMemberByHandle(
  workspaceId: string,
  handle: string,
): Promise<{ memberId: string; agentId: string; name: string } | undefined> {
  const [row] = await db
    .select({ memberId: members.id, agentId: agents.id, name: members.displayName })
    .from(members)
    .innerJoin(agents, eq(agents.id, members.agentId))
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        eq(members.kind, "agent"),
        sql`lower(${members.displayName}) = lower(${handle})`,
        isNull(agents.deactivatedAt),
      ),
    )
    .limit(1);
  return row;
}

/** The agent registry for a workspace (profiles). */
export async function listAgents(workspaceId: string): Promise<
  {
    id: string;
    name: string;
    framework: string | null;
    ownerUserId: string | null;
    deactivatedAt: Date | null;
    createdAt: Date;
  }[]
> {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      framework: agents.framework,
      ownerUserId: agents.ownerUserId,
      deactivatedAt: agents.deactivatedAt,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
}

/**
 * Deactivate an agent (workspace-scoped, prevents cross-tenant deactivation): flags it and
 * revokes all its live tokens so it can no longer authenticate. Returns false if not found
 * in that workspace. Effect is immediate (resolveIdentity re-checks per request).
 */
export async function deactivateAgent(agentId: string, workspaceId: string): Promise<boolean> {
  const res = await db
    .update(agents)
    .set({ deactivatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .returning({ id: agents.id });
  if (res.length === 0) return false;
  await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentTokens.agentId, agentId),
        eq(agentTokens.workspaceId, workspaceId),
        isNull(agentTokens.revokedAt),
      ),
    );
  return true;
}
