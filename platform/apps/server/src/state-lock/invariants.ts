/**
 * Corruption-detection invariants (issue #639). Pure predicates over {@link SharedStateRecord}s that
 * encode what "consistent shared state" *means*, so a violation can be caught and refused instead of
 * persisted. Two scopes:
 *
 *   - **Per-record** ({@link checkRecord}): a record's own shape is sane — positive integer version,
 *     non-empty key/workspace, finite timestamp.
 *   - **Per-transition** ({@link checkTransition}): a write advances version by *exactly one* and never
 *     changes identity (key/workspace) — the heart of lost-update detection. If two writers both read
 *     version N and each tries to commit N+1, a correct serialized path produces N→N+1→N+2; a skipped or
 *     duplicated version (N→N, N→N+2) is corruption and trips this check.
 *
 * `assert*` variants throw {@link InvariantViolationError}; the bare `check*` variants return a reason
 * string (or null when consistent) so callers can test without catching.
 */

import { InvariantViolationError, type SharedStateRecord } from "./types.js";

/** Returns a human reason if `record` is internally inconsistent, else null. */
export function checkRecord(record: SharedStateRecord): string | null {
  if (typeof record.key !== "string" || record.key.length === 0) return "empty key";
  if (typeof record.workspaceId !== "string" || record.workspaceId.length === 0) return "empty workspaceId";
  if (!Number.isInteger(record.version)) return `version ${record.version} is not an integer`;
  if (record.version < 1) return `version ${record.version} is below 1`;
  if (!Number.isFinite(record.updatedAtMs)) return `updatedAtMs ${record.updatedAtMs} is not finite`;
  return null;
}

/** Returns a human reason if the `prev → next` write is not a valid single-step advance, else null. */
export function checkTransition(prev: SharedStateRecord, next: SharedStateRecord): string | null {
  const prevBad = checkRecord(prev);
  if (prevBad) return `prev: ${prevBad}`;
  const nextBad = checkRecord(next);
  if (nextBad) return `next: ${nextBad}`;
  if (prev.workspaceId !== next.workspaceId) return "workspaceId changed across write";
  if (prev.key !== next.key) return "key changed across write";
  if (next.version !== prev.version + 1) {
    return `version did not advance by one (${prev.version} → ${next.version})`;
  }
  return null;
}

/** Throw {@link InvariantViolationError} if `record` is internally inconsistent. */
export function assertRecord(record: SharedStateRecord): void {
  const reason = checkRecord(record);
  if (reason) throw new InvariantViolationError(reason);
}

/** Throw {@link InvariantViolationError} if the `prev → next` write is not a valid single-step advance. */
export function assertTransition(prev: SharedStateRecord, next: SharedStateRecord): void {
  const reason = checkTransition(prev, next);
  if (reason) throw new InvariantViolationError(reason);
}

/**
 * Verify a full write history for one entity is gap-free and strictly increasing from its first version:
 * `[v, v+1, v+2, …]`. This is the post-hoc corruption probe a stress test runs — if any concurrent writer
 * had its update silently dropped, the recorded versions would skip a number and this returns a reason.
 * Returns null when the history is a perfect run.
 */
export function checkVersionHistory(versions: readonly number[]): string | null {
  for (let i = 1; i < versions.length; i++) {
    const expected = (versions[0] ?? 0) + i;
    if (versions[i] !== expected) {
      return `version history broke at index ${i}: expected ${expected}, got ${versions[i]}`;
    }
  }
  return null;
}
