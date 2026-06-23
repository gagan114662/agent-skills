import { and, asc, desc, eq, gt, isNull, count } from "drizzle-orm";
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
export async function listChannelMessages(channelId: string, limit?: number): Promise<Message[]> {
  const boundedLimit = limit && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  const rows = await db
    .select(messageColumns)
    .from(messages)
    .where(and(eq(messages.channelId, channelId), isNull(messages.deletedAt)))
    .orderBy(boundedLimit ? desc(messages.createdAt) : asc(messages.createdAt))
    .limit(boundedLimit ?? 100_000);
  const out = rows as Message[];
  return boundedLimit ? out.reverse() : out;
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

/**
 * The conversation cursor for checkpoints (#53): the id of the channel's most recent non-deleted
 * message, or null when the channel is empty. Ids are time-sortable UUIDv7, so "most recent" is
 * simply the max id — and `id > cursor` means "created after the cursor".
 */
export async function latestMessageId(channelId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Soft-delete every non-deleted message in the channel created strictly after `afterMessageId` (the
 * conversation half of a checkpoint revert, #53). Returns how many were tombstoned. A null cursor is
 * a no-op (nothing to truncate). Scoped to the one channel — never touches other channels' messages.
 */
export async function softDeleteMessagesAfter(
  channelId: string,
  afterMessageId: string | null,
): Promise<number> {
  if (!afterMessageId) return 0;
  const rows = await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        gt(messages.id, afterMessageId),
      ),
    )
    .returning({ id: messages.id });
  return rows.length;
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
