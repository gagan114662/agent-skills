import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../index.js";
import { messages } from "../schema/index.js";

export interface Message {
  id: string;
  channelId: string;
  authorMemberId: string;
  parentMessageId: string | null;
  body: string;
}

export async function postMessage(input: {
  workspaceId: string;
  channelId: string;
  authorMemberId: string;
  body: string;
  parentMessageId?: string;
}): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      authorMemberId: input.authorMemberId,
      body: input.body,
      parentMessageId: input.parentMessageId ?? null,
    })
    .returning({
      id: messages.id,
      channelId: messages.channelId,
      authorMemberId: messages.authorMemberId,
      parentMessageId: messages.parentMessageId,
      body: messages.body,
    });
  return row as Message;
}

/** Channel messages in chronological order, excluding soft-deleted ones. */
export async function listChannelMessages(channelId: string): Promise<Message[]> {
  return db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      authorMemberId: messages.authorMemberId,
      parentMessageId: messages.parentMessageId,
      body: messages.body,
    })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt));
}

/** Soft-delete: tombstones the message but keeps the row (preserves threads). */
export async function softDeleteMessage(id: string): Promise<void> {
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, id));
}

/** True iff the message exists *in this workspace* — the #14 link-target IDOR guard. */
export async function messageInWorkspace(id: string, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.workspaceId, workspaceId)))
    .limit(1);
  return row !== undefined;
}
