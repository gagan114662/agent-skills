import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../index.js";
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

export async function revokeAgentToken(tokenId: string): Promise<void> {
  await db.update(agentTokens).set({ revokedAt: new Date() }).where(eq(agentTokens.id, tokenId));
}

export async function getAgentMember(
  agentId: string,
  workspaceId: string,
): Promise<{ id: string; displayName: string } | undefined> {
  const [row] = await db
    .select({ id: members.id, displayName: members.displayName })
    .from(members)
    .where(and(eq(members.agentId, agentId), eq(members.workspaceId, workspaceId)))
    .limit(1);
  return row;
}
