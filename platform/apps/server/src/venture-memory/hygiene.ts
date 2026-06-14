import { slugify } from "./memory.js";
import type { VentureMemoryEntry } from "./types.js";

/**
 * Memory hygiene (#197 AC5, ADR-0197). **Pure** — no DB. Dedupe and staleness review so the venture's
 * belief set stays trustworthy and the owner-visible "what does it believe" surface is honest. Stale =
 * superseded (#16) or aged past the review window; dedupe collapses same-kind restatements, keeping the
 * newest. The IO layer acts on the result (superseding / surfacing for review).
 */

const DAY_MS = 86_400_000;

export interface StalenessReview {
  /** Fresh, in-window beliefs — what the venture currently believes. */
  fresh: VentureMemoryEntry[];
  /** Already superseded (#16) — kept for lineage, shown only in the audit. */
  superseded: VentureMemoryEntry[];
  /** Aged past the review window but not yet superseded — needs an owner glance. */
  needsReview: VentureMemoryEntry[];
}

/**
 * Partition a venture's memories into fresh / superseded / needs-review against a clock + a review
 * window. A superseded node is never "fresh"; a non-superseded node older than `staleAfterDays` is
 * surfaced for review (not auto-deleted — the owner decides). Deterministic ordering (input order kept).
 */
export function reviewStaleness(
  entries: VentureMemoryEntry[],
  nowMs: number,
  staleAfterDays: number,
): StalenessReview {
  const cutoff = staleAfterDays * DAY_MS;
  const fresh: VentureMemoryEntry[] = [];
  const superseded: VentureMemoryEntry[] = [];
  const needsReview: VentureMemoryEntry[] = [];
  for (const e of entries) {
    if (e.stale) {
      superseded.push(e);
    } else if (staleAfterDays > 0 && nowMs - e.createdAtMs >= cutoff) {
      needsReview.push(e);
    } else {
      fresh.push(e);
    }
  }
  return { fresh, superseded, needsReview };
}

/** The dedupe identity of an entry: same kind + same normalized statement = the same belief. */
export function entryDedupeKey(entry: Pick<VentureMemoryEntry, "kind" | "text">): string {
  return `${entry.kind}:${slugify(entry.text)}`;
}

/**
 * Collapse same-kind restatements, keeping the FIRST occurrence (callers pass newest-first, so the
 * freshest survives). Pure ⇒ the "what does it believe" view and the brief see one belief per statement.
 */
export function dedupeEntries(entries: VentureMemoryEntry[]): VentureMemoryEntry[] {
  const seen = new Set<string>();
  const out: VentureMemoryEntry[] = [];
  for (const e of entries) {
    const key = entryDedupeKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
