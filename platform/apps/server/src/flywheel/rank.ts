import type { FingerprintRecord } from "./types.js";

/**
 * Rank fingerprints so the tick acts on the most-impactful one first (#117, ADR-0117 §3). **Pure**:
 * most occurrences first (the loudest failure), ties broken by most-recently-seen (the freshest pain).
 * The engine drafts issues and dispatches the top-ranked fix in this order. Does not mutate the input.
 */
export function rankFingerprints(fingerprints: FingerprintRecord[]): FingerprintRecord[] {
  return [...fingerprints].sort((a, b) => {
    if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
    return b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
  });
}
