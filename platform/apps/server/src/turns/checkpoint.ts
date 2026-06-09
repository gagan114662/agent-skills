/**
 * Pure revert-selection logic (issue #53, ADR-0030). A session's checkpoint ledger is an ordered
 * list of turns; turn 0 is the **baseline** (the state before any work). Reverting turn T restores
 * the state **before** T — the previous checkpoint's worktree snapshot + conversation cursor — and
 * discards T and every turn after it. No I/O: the controller feeds the live (non-reverted) turns and
 * applies the returned plan (git reset + message soft-delete).
 */

/** One checkpoint in a session's ledger (a row of `session_turns`). */
export interface TurnRow {
  id: string;
  /** 0-based order within the session; idx 0 is the baseline. */
  idx: number;
  /** The committed worktree snapshot at this checkpoint (null only for a snapshot-less baseline). */
  headSha: string | null;
  /** The channel's latest message id at this checkpoint (the conversation cursor). */
  cursorMessageId: string | null;
}

/** What a revert restores. `restoreSha` is always a real, server-stored sha (never client input). */
export interface RevertPlan {
  restoreSha: string;
  /** Soft-delete channel messages created after this cursor; null ⇒ nothing to truncate. */
  truncateAfterMessageId: string | null;
  /** The target turn and every later turn — marked reverted. */
  discardedTurnIds: string[];
}

/** Thrown when the requested revert target is invalid. */
export class CheckpointError extends Error {}

/**
 * Compute the revert plan for "revert to before `targetTurnId`". Restores the previous checkpoint's
 * snapshot + cursor and discards the target..end suffix. Throws for an unknown turn, the baseline
 * (idx 0 — nothing precedes it), or a predecessor that has no snapshot to restore to.
 */
export function planRevert(turns: TurnRow[], targetTurnId: string): RevertPlan {
  const ordered = [...turns].sort((a, b) => a.idx - b.idx);
  const pos = ordered.findIndex((t) => t.id === targetTurnId);
  if (pos < 0) throw new CheckpointError("turn not found in this session");
  if (pos === 0) throw new CheckpointError("cannot revert the baseline checkpoint");
  const prev = ordered[pos - 1];
  if (!prev || prev.headSha === null) {
    throw new CheckpointError("the previous checkpoint has no snapshot to restore");
  }
  return {
    restoreSha: prev.headSha,
    truncateAfterMessageId: prev.cursorMessageId,
    discardedTurnIds: ordered.slice(pos).map((t) => t.id),
  };
}
