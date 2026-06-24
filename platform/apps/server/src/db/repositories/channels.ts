import { and, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { channels, channelMembers } from "../schema/index.js";

export interface Channel {
  id: string;
  workspaceId: string;
  kind: "public" | "dm";
  name: string | null;
  isArchived: boolean;
}

export async function createChannel(input: {
  workspaceId: string;
  kind: "public" | "dm";
  name?: string;
}): Promise<Channel> {
  const [row] = await db
    .insert(channels)
    .values({ workspaceId: input.workspaceId, kind: input.kind, name: input.name ?? null })
    .returning();
  return row as Channel;
}

export async function getChannel(id: string): Promise<Channel | undefined> {
  const [row] = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
  return row as Channel | undefined;
}

/** Non-archived channels in a workspace. */
export async function listChannels(workspaceId: string): Promise<Channel[]> {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.isArchived, false)));
  return rows as Channel[];
}

export async function archiveChannel(id: string): Promise<void> {
  await db.update(channels).set({ isArchived: true }).where(eq(channels.id, id));
}

export async function addChannelMember(channelId: string, memberId: string): Promise<void> {
  await db.insert(channelMembers).values({ channelId, memberId }).onConflictDoNothing();
}

export async function removeChannelMember(channelId: string, memberId: string): Promise<void> {
  await db
    .delete(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberId, memberId)));
}

/** All member ids in a channel — used for DM notification fan-out (#8). */
export async function listChannelMemberIds(channelId: string): Promise<string[]> {
  const rows = await db
    .select({ memberId: channelMembers.memberId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId));
  return rows.map((r) => r.memberId);
}

export async function isChannelMember(channelId: string, memberId: string): Promise<boolean> {
  const [row] = await db
    .select({ memberId: channelMembers.memberId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberId, memberId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Get-or-create a DM channel for an exact member set (ADR-0004). Deduped by the sorted
 * set of member ids, compared inside a transaction to avoid duplicate DMs.
 */
export async function getOrCreateDm(
  workspaceId: string,
  memberIds: string[],
): Promise<Channel> {
  const wanted = [...new Set(memberIds)].sort();
  const wantedSql = sql.join(
    wanted.map((memberId) => sql`${memberId}`),
    sql`, `,
  );
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(channels.kind, "dm"),
          sql`(select count(*)::int from ${channelMembers} where ${channelMembers.channelId} = ${channels.id}) = ${wanted.length}`,
          sql`(select count(*)::int from ${channelMembers} where ${channelMembers.channelId} = ${channels.id} and ${channelMembers.memberId} in (${wantedSql})) = ${wanted.length}`,
        ),
      )
      .limit(1);
    if (existing) return existing as Channel;

    const [created] = await tx
      .insert(channels)
      .values({ workspaceId, kind: "dm", name: null })
      .returning();
    await tx.insert(channelMembers).values(wanted.map((memberId) => ({ channelId: created!.id, memberId })));
    return created as Channel;
  });
}
