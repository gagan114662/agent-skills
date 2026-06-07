import { and, asc, eq, isNull, count } from "drizzle-orm";
import { db } from "../index.js";
import { messages } from "../schema/index.js";

export interface Message {
  id: string;
  channelId: string;
  authorMemberId: string;
  parentMessageId: string | null;
  alsoSentToChannel: boolean;
  body: string;
}

/** The columns that make up the public Message shape (REST + realtime payloads). */
const messageColumns = {
  id: messages.id,
  channelId: messages.channelId,
  authorMemberId: messages.authorMemberId,
  parentMessageId: messages.parentMessageId,
  alsoSentToChannel: messages.alsoSentToChannel,
  body: messages.body,
};

export async function postMessage(input: {
  workspaceId: string;
  channelId: string;
  authorMemberId: string;
  body: string;
  parentMessageId?: string;
  alsoSentToChannel?: boolean;
}): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      authorMemberId: input.authorMemberId,
      body: input.body,
      parentMessageId: input.parentMessageId ?? null,
      alsoSentToChannel: input.alsoSentToChannel ?? false,
    })
    .returning(messageColumns);
  return row as Message;
}

/** A single non-deleted message by id, or undefined (used to validate a thread parent). */
export async function getMessage(id: string): Promise<Message | undefined> {
  const [row] = await db
    .select(messageColumns)
    .from(messages)
    .where(and(eq(messages.id, id), isNull(messages.deletedAt)))
    .limit(1);
  return row as Message | undefined;
}

/** Channel messages in chronological order, excluding soft-deleted ones (flat #4 contract). */
export async function listChannelMessages(channelId: string): Promise<Message[]> {
  return db
    .select(messageColumns)
    .from(messages)
    .where(and(eq(messages.channelId, channelId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt)) as Promise<Message[]>;
}

/** A thread's replies (children of `rootId`) in chronological order, excluding deleted. */
export async function listThreadReplies(rootId: string): Promise<Message[]> {
  return db
    .select(messageColumns)
    .from(messages)
    .where(and(eq(messages.parentMessageId, rootId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt)) as Promise<Message[]>;
}

/** Number of non-deleted replies under a root message. */
export async function countReplies(rootId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.parentMessageId, rootId), isNull(messages.deletedAt)));
  return row?.n ?? 0;
}

/** Soft-delete: tombstones the message but keeps the row (preserves threads). */
export async function softDeleteMessage(id: string): Promise<void> {
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, id));
}
