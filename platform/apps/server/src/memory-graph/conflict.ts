/**
 * Conflict detection (issue #585) — the pure core that turns "agents contradict each other" into a concrete,
 * explainable signal. Side-effect-free: the store hands it an incoming claim and the existing active claims
 * about the same subject, and it returns every contradiction. No IO, so it is unit-tested directly.
 *
 * The rule is deliberately deterministic (no NLP): a **claim** asserts a `value` for a (`subject`,
 * `predicate`) pair. Two active claims about the same (subject, predicate) whose normalized values differ
 * are a contradiction. Same value ⇒ agreement (and the store dedups it to one node). Findings/research
 * (predicate `null`) have no truth-value to contradict — they only dedup.
 */

import { normalizeText, subjectKey } from "./normalize.js";
import type { Conflict, GraphNode } from "./types.js";

/** The minimal claim shape conflict detection needs — a subset of {@link GraphNode}. */
export interface ClaimLike {
  id: string;
  subject: string;
  predicate: string | null;
  value: string;
  confidence: number;
  status: GraphNode["status"];
}

/** Whether a node is a claim that can participate in a contradiction (active, with a predicate). */
export function isClaim(node: Pick<ClaimLike, "predicate" | "status">): boolean {
  return node.status === "active" && node.predicate !== null && node.predicate !== "";
}

/**
 * Find every contradiction between `incoming` and the `existing` nodes. Returns `[]` when `incoming` is not a
 * claim (nothing to contradict) or when no active claim disagrees. The candidate's own id (if it is already
 * persisted) is skipped, so re-checking a stored claim never reports it as conflicting with itself.
 */
export function detectConflicts(incoming: ClaimLike, existing: ClaimLike[]): Conflict[] {
  if (!isClaim(incoming)) return [];

  const subj = subjectKey(incoming.subject);
  const pred = normalizeText(incoming.predicate as string);
  const value = normalizeText(incoming.value);

  const conflicts: Conflict[] = [];
  for (const other of existing) {
    if (other.id === incoming.id) continue;
    if (!isClaim(other)) continue;
    if (subjectKey(other.subject) !== subj) continue;
    if (normalizeText(other.predicate as string) !== pred) continue;
    if (normalizeText(other.value) === value) continue; // same value ⇒ agreement, not conflict
    conflicts.push({
      subject: incoming.subject,
      predicate: incoming.predicate as string,
      existingNodeId: other.id,
      existingValue: other.value,
      existingConfidence: other.confidence,
      incomingValue: incoming.value,
      incomingConfidence: incoming.confidence,
    });
  }
  return conflicts;
}

/**
 * Summarize a set of conflicts into a single human-readable line for a pre-publish flag. Returns `null` when
 * there is no conflict, so a caller can do `const warn = summarizeConflicts(c); if (warn) flag(warn);`.
 */
export function summarizeConflicts(conflicts: Conflict[]): string | null {
  if (conflicts.length === 0) return null;
  const parts = conflicts.map(
    (c) =>
      `"${c.subject}" ${c.predicate}: this claim says "${c.incomingValue}" but the graph already records ` +
      `"${c.existingValue}" (node ${c.existingNodeId})`,
  );
  return `${conflicts.length} contradiction${conflicts.length === 1 ? "" : "s"} with existing memory — ${parts.join("; ")}`;
}
