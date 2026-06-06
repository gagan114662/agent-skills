import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import { channels, channelMembers } from "../schema/index.js";

export interface Channel {
  id: string;
  kind: "public" | "dm";
  name: string | null;
}

export async function createChannel(input: {
  workspaceId: string;
  kind: "public" | "dm";
  name?: string;
}): Promise<Channel> {
  const [row] = await db
    .insert(channels)
    .values({ workspaceId: input.workspaceId, kind: input.kind, name: input.name ?? null })
    .returning({ id: channels.id, kind: channels.kind, name: channels.name });
  return row as Channel;
}

export async function addChannelMember(channelId: string, memberId: string): Promise<void> {
  await db.insert(channelMembers).values({ channelId, memberId }).onConflictDoNothing();
}

export async function isChannelMember(channelId: string, memberId: string): Promise<boolean> {
  const [row] = await db
    .select({ memberId: channelMembers.memberId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberId, memberId)))
    .limit(1);
  return row !== undefined;
}
