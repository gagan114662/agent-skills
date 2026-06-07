import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import { users, agents, members } from "../schema/index.js";

export interface Member {
  id: string;
  kind: "human" | "agent";
  displayName: string;
}

/** True iff the member exists *in this workspace* — the #9 cross-workspace grant guard (IDOR). */
export async function memberInWorkspace(memberId: string, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.workspaceId, workspaceId)))
    .limit(1);
  return row !== undefined;
}

/** Fetch a member scoped to a workspace (kind + display name), or undefined (cross-tenant safe). */
export async function getWorkspaceMember(
  memberId: string,
  workspaceId: string,
): Promise<Member | undefined> {
  const [row] = await db
    .select({ id: members.id, kind: members.kind, displayName: members.displayName })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.workspaceId, workspaceId)))
    .limit(1);
  return row as Member | undefined;
}

/** Create a human user (global) and their member row in a workspace. */
export async function createHumanMember(input: {
  workspaceId: string;
  email: string;
  displayName: string;
}): Promise<Member> {
  const [user] = await db
    .insert(users)
    .values({ email: input.email, displayName: input.displayName })
    .returning({ id: users.id });
  const [member] = await db
    .insert(members)
    .values({
      workspaceId: input.workspaceId,
      kind: "human",
      userId: user!.id,
      displayName: input.displayName,
    })
    .returning({ id: members.id, kind: members.kind, displayName: members.displayName });
  return member as Member;
}

/** Create an agent (workspace-scoped) and its member row. */
export async function createAgentMember(input: {
  workspaceId: string;
  name: string;
  framework?: string;
  ownerUserId?: string;
}): Promise<Member> {
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
    .returning({ id: members.id, kind: members.kind, displayName: members.displayName });
  return member as Member;
}
