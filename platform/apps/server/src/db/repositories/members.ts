import { db } from "../index.js";
import { users, agents, members } from "../schema/index.js";

export interface Member {
  id: string;
  kind: "human" | "agent";
  displayName: string;
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
