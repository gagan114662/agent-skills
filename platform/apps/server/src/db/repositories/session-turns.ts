import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../index.js";
import { sessionTurns } from "../schema/index.js";

export type TurnKind = "baseline" | "work";

export interface SessionTurn {
  id: string;
  workspaceId: string;
  channelId: string;
  sessionId: string;
  idx: number;
  kind: TurnKind;
  headSha: string | null;
  cursorMessageId: string | null;
  planProposalId: string | null;
  createdByMemberId: string | null;
  revertedAt: Date | null;
  createdAt: Date;
}

const COLUMNS = {
  id: sessionTurns.id,
  workspaceId: sessionTurns.workspaceId,
  channelId: sessionTurns.channelId,
  sessionId: sessionTurns.sessionId,
  idx: sessionTurns.idx,
  kind: sessionTurns.kind,
  headSha: sessionTurns.headSha,
  cursorMessageId: sessionTurns.cursorMessageId,
  planProposalId: sessionTurns.planProposalId,
  createdByMemberId: sessionTurns.createdByMemberId,
  revertedAt: sessionTurns.revertedAt,
  createdAt: sessionTurns.createdAt,
} as const;

export async function createSessionTurn(input: {
  workspaceId: string;
  channelId: string;
  sessionId: string;
  idx: number;
  kind: TurnKind;
  headSha: string | null;
  cursorMessageId: string | null;
  planProposalId?: string | null;
  createdByMemberId?: string | null;
}): Promise<SessionTurn> {
  const [row] = await db
    .insert(sessionTurns)
    .values({
      ...input,
      planProposalId: input.planProposalId ?? null,
      createdByMemberId: input.createdByMemberId ?? null,
    })
    .returning(COLUMNS);
  return row as SessionTurn;
}

/** A session's turns ordered by idx (oldest first). Pass `liveOnly` to drop already-reverted turns. */
export async function listSessionTurns(
  sessionId: string,
  opts: { liveOnly?: boolean } = {},
): Promise<SessionTurn[]> {
  const where = opts.liveOnly
    ? and(eq(sessionTurns.sessionId, sessionId), isNull(sessionTurns.revertedAt))
    : eq(sessionTurns.sessionId, sessionId);
  const rows = await db.select(COLUMNS).from(sessionTurns).where(where).orderBy(asc(sessionTurns.idx));
  return rows as SessionTurn[];
}

/** The next 0-based idx for a session (so the first turn is the baseline at idx 0). */
export async function nextTurnIdx(sessionId: string): Promise<number> {
  const rows = await db
    .select({ idx: sessionTurns.idx })
    .from(sessionTurns)
    .where(eq(sessionTurns.sessionId, sessionId));
  return rows.reduce((max, r) => Math.max(max, r.idx + 1), 0);
}

/** Mark a set of turns reverted (idempotent — only stamps rows not already reverted). */
export async function markTurnsReverted(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(sessionTurns)
    .set({ revertedAt: new Date() })
    .where(and(inArray(sessionTurns.id, ids), isNull(sessionTurns.revertedAt)));
}
