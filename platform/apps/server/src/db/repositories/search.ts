import { and, desc, eq, gte, isNull, lt, sql, type SQL } from "drizzle-orm";
import { db } from "../index.js";
import { messages, channels, channelMembers, members } from "../schema/index.js";

/**
 * Permission-scoped search (#7). The access gate is a single SQL predicate reused by every
 * query: results are restricted to channels the caller is a member of (ADR-0009: membership
 * is the projection of `effectiveCapability >= read`). No per-row capability call, no JS-side
 * filtering — so pagination counts stay correct and nothing can leak via a filter.
 *
 * All user input is parameterized (Drizzle `sql` placeholders); the `%…%` for ILIKE is
 * concatenated in SQL, never interpolated in JS.
 */

/** Channels the caller can read, as a subquery for `channel_id IN (…)`. */
function readableChannelIds(callerMemberId: string): SQL {
  return sql`(select ${channelMembers.channelId} from ${channelMembers} where ${eq(
    channelMembers.memberId,
    callerMemberId,
  )})`;
}

export interface MessageHit {
  id: string;
  channelId: string;
  authorMemberId: string;
  parentMessageId: string | null;
  body: string;
  createdAt: Date;
  rank: number;
}

export interface SearchMessagesOpts {
  workspaceId: string;
  callerMemberId: string;
  q: string;
  limit: number;
  offset: number;
  channelId?: string;
  authorMemberId?: string;
  after?: Date;
  before?: Date;
  threadId?: string;
}

/** Full-text search over messages, ranked by relevance then recency, permission-scoped. */
export async function searchMessages(opts: SearchMessagesOpts): Promise<MessageHit[]> {
  // websearch_to_tsquery tolerates arbitrary user input (quotes, or, -) and never throws.
  const tsquery = sql`websearch_to_tsquery('english', ${opts.q})`;
  const rank = sql<number>`ts_rank(${messages.bodyTsv}, ${tsquery})`;

  const conditions: SQL[] = [
    isNull(messages.deletedAt),
    eq(messages.workspaceId, opts.workspaceId),
    sql`${messages.channelId} in ${readableChannelIds(opts.callerMemberId)}`,
    sql`${messages.bodyTsv} @@ ${tsquery}`,
  ];
  if (opts.channelId) conditions.push(eq(messages.channelId, opts.channelId));
  if (opts.authorMemberId) conditions.push(eq(messages.authorMemberId, opts.authorMemberId));
  if (opts.after) conditions.push(gte(messages.createdAt, opts.after));
  if (opts.before) conditions.push(lt(messages.createdAt, opts.before));
  if (opts.threadId) conditions.push(eq(messages.parentMessageId, opts.threadId));

  return db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      authorMemberId: messages.authorMemberId,
      parentMessageId: messages.parentMessageId,
      body: messages.body,
      createdAt: messages.createdAt,
      rank,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(rank), desc(messages.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
}

export interface ChannelHit {
  id: string;
  workspaceId: string;
  kind: "public" | "dm";
  name: string | null;
  isArchived: boolean;
}

/** Channel name search (ILIKE), scoped to the caller's non-archived channels. */
export async function searchChannels(opts: {
  workspaceId: string;
  callerMemberId: string;
  q: string;
  limit: number;
  offset: number;
}): Promise<ChannelHit[]> {
  const rows = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, opts.workspaceId),
        eq(channels.isArchived, false),
        sql`${channels.id} in ${readableChannelIds(opts.callerMemberId)}`,
        sql`${channels.name} ilike '%' || ${opts.q} || '%'`,
      ),
    )
    .orderBy(channels.name)
    .limit(opts.limit)
    .offset(opts.offset);
  return rows as ChannelHit[];
}

export interface MemberHit {
  id: string;
  kind: "human" | "agent";
  displayName: string;
}

/** Member name search (ILIKE), scoped to the caller's workspace. */
export async function searchMembers(opts: {
  workspaceId: string;
  q: string;
  limit: number;
  offset: number;
}): Promise<MemberHit[]> {
  const rows = await db
    .select({ id: members.id, kind: members.kind, displayName: members.displayName })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, opts.workspaceId),
        sql`${members.displayName} ilike '%' || ${opts.q} || '%'`,
      ),
    )
    .orderBy(members.displayName)
    .limit(opts.limit)
    .offset(opts.offset);
  return rows as MemberHit[];
}
