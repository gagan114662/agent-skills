import { and, desc, eq, count, inArray, sql } from "drizzle-orm";
import { db } from "../index.js";
import { messageMentions, members, messages } from "../schema/index.js";
import { parseMentionTokens } from "../../messaging/mentions.js";

/** A mention as carried in realtime events and the "my mentions" feed. */
export interface Mention {
  id: string;
  workspaceId: string;
  channelId: string;
  messageId: string;
  mentionedMemberId: string;
  mentionedMemberKind: "human" | "agent";
  authorMemberId: string;
  body: string;
}

/**
 * Resolve @handle tokens in a message body to workspace members, persist a mention row per
 * resolved member, and return the persisted mentions (with member kind so the caller can
 * treat an agent mention as an actionable event). The author is excluded (no self-mentions),
 * unknown handles are skipped, and inserts are idempotent via UNIQUE(message_id, member).
 */
export async function resolveAndPersistMentions(input: {
  workspaceId: string;
  channelId: string;
  messageId: string;
  authorMemberId: string;
  body: string;
}): Promise<Mention[]> {
  const tokens = parseMentionTokens(input.body);
  if (tokens.length === 0) return [];

  // Resolve tokens → members by case-insensitive display name, scoped to this workspace.
  // Exclude the author so a self-mention never creates a record/notification.
  const matched = await db
    .select({ id: members.id, kind: members.kind, displayName: members.displayName })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, input.workspaceId),
        inArray(sql`lower(${members.displayName})`, tokens),
      ),
    );
  const targets = matched.filter((m) => m.id !== input.authorMemberId);
  if (targets.length === 0) return [];

  const inserted = await db
    .insert(messageMentions)
    .values(
      targets.map((m) => ({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: input.messageId,
        mentionedMemberId: m.id,
        authorMemberId: input.authorMemberId,
      })),
    )
    .onConflictDoNothing()
    .returning({
      id: messageMentions.id,
      mentionedMemberId: messageMentions.mentionedMemberId,
    });

  const kindById = new Map(targets.map((m) => [m.id, m.kind]));
  return inserted.map((row) => ({
    id: row.id,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    messageId: input.messageId,
    mentionedMemberId: row.mentionedMemberId,
    mentionedMemberKind: kindById.get(row.mentionedMemberId) as "human" | "agent",
    authorMemberId: input.authorMemberId,
    body: input.body,
  }));
}

/** A member's mentions, newest first, joined with the mentioning message's body. */
export async function listMentionsForMember(
  workspaceId: string,
  memberId: string,
): Promise<
  Array<{
    id: string;
    messageId: string;
    channelId: string;
    authorMemberId: string;
    body: string;
    createdAt: Date;
  }>
> {
  return db
    .select({
      id: messageMentions.id,
      messageId: messageMentions.messageId,
      channelId: messageMentions.channelId,
      authorMemberId: messageMentions.authorMemberId,
      body: messages.body,
      createdAt: messageMentions.createdAt,
    })
    .from(messageMentions)
    .innerJoin(messages, eq(messageMentions.messageId, messages.id))
    .where(
      and(
        eq(messageMentions.workspaceId, workspaceId),
        eq(messageMentions.mentionedMemberId, memberId),
      ),
    )
    .orderBy(desc(messageMentions.createdAt));
}

/** How many times a member has been mentioned in their workspace. */
export async function countMentionsForMember(
  workspaceId: string,
  memberId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messageMentions)
    .where(
      and(
        eq(messageMentions.workspaceId, workspaceId),
        eq(messageMentions.mentionedMemberId, memberId),
      ),
    );
  return row?.n ?? 0;
}
