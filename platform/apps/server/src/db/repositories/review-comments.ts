import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ReviewCommentDto } from "@reload/shared";
import { db } from "../index.js";
import { reviewComments } from "../schema/index.js";

const COLUMNS = {
  id: reviewComments.id,
  workspaceId: reviewComments.workspaceId,
  channelId: reviewComments.channelId,
  sessionId: reviewComments.sessionId,
  pullRequestId: reviewComments.pullRequestId,
  filePath: reviewComments.filePath,
  lineStart: reviewComments.lineStart,
  lineEnd: reviewComments.lineEnd,
  body: reviewComments.body,
  authorMemberId: reviewComments.authorMemberId,
  deliveredToSessionId: reviewComments.deliveredToSessionId,
  createdAt: reviewComments.createdAt,
} as const;

/** A persisted review-comment row (Date field); map to {@link ReviewCommentDto} via {@link toCommentDto}. */
export interface ReviewCommentRow {
  id: string;
  workspaceId: string;
  channelId: string;
  sessionId: string;
  pullRequestId: string | null;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  body: string;
  authorMemberId: string | null;
  deliveredToSessionId: string | null;
  createdAt: Date;
}

/** Serialize a row to its wire DTO (date → ISO-8601). */
export function toCommentDto(row: ReviewCommentRow): ReviewCommentDto {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export async function createReviewComment(input: {
  workspaceId: string;
  channelId: string;
  sessionId: string;
  pullRequestId?: string | null;
  filePath: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  body: string;
  authorMemberId: string;
}): Promise<ReviewCommentRow> {
  const [row] = await db
    .insert(reviewComments)
    .values({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      sessionId: input.sessionId,
      pullRequestId: input.pullRequestId ?? null,
      filePath: input.filePath,
      lineStart: input.lineStart ?? null,
      lineEnd: input.lineEnd ?? null,
      body: input.body,
      authorMemberId: input.authorMemberId,
    })
    .returning(COLUMNS);
  return row as ReviewCommentRow;
}

/** Comments on a session's diff, oldest first. Channel-scoped (IDOR-safe). */
export async function listReviewComments(
  sessionId: string,
  channelId: string,
): Promise<ReviewCommentRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(reviewComments)
    .where(and(eq(reviewComments.sessionId, sessionId), eq(reviewComments.channelId, channelId)))
    .orderBy(asc(reviewComments.createdAt));
  return rows as ReviewCommentRow[];
}

/** Undelivered comments for a session (the ones a `deliver` round-trip will forward). */
export async function listUndeliveredComments(
  sessionId: string,
  channelId: string,
): Promise<ReviewCommentRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.sessionId, sessionId),
        eq(reviewComments.channelId, channelId),
        isNull(reviewComments.deliveredToSessionId),
      ),
    )
    .orderBy(asc(reviewComments.createdAt));
  return rows as ReviewCommentRow[];
}

/** Stamp a set of comments as delivered to a follow-up session (the round-trip evidence). */
export async function markCommentsDelivered(
  ids: string[],
  deliveredToSessionId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(reviewComments)
    .set({ deliveredToSessionId })
    .where(inArray(reviewComments.id, ids));
}
