/**
 * Outreach queue ordering (issue #611). The acceptance criterion: "the outreach queue is ordered by intent
 * score." This module turns a bag of leads into a ranked work list an agent drains highest-intent-first.
 *
 * Pure + deterministic: the sort is total and stable (score desc, then a documented tiebreak), so the same
 * leads always produce the same order — no clock, no randomness, no DB. The score that drives the order is the
 * fully-explainable {@link LeadScore}, carried through onto every queue entry so the "why this is #1" is right
 * there next to the rank.
 */

import { resolveQueuePolicy, type QueuePolicy } from "./caps.js";
import { scoreLead } from "./score.js";
import type { LeadInput, LeadScore } from "./types.js";

/** A scored lead in its queue position. Agents work `rank` 1 first. Extends {@link LeadScore} — the full explanation rides along. */
export interface OutreachQueueEntry extends LeadScore {
  /** 1-based position in the queue after sorting + policy filtering. */
  rank: number;
}

/**
 * Compare two scored leads for queue order: higher intent score first; ties broken deterministically by
 * `leadId` ascending so the ordering is total and reproducible (never clock- or insertion-order-dependent).
 */
export function compareByIntent(a: LeadScore, b: LeadScore): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0;
}

/**
 * Score every lead, drop those below the policy's `minScore`, sort by intent (desc), apply the optional
 * top-N `limit`, and assign 1-based ranks. Pass an explicit {@link QueuePolicy} to override the env-resolved
 * default (the env path is what production uses; the explicit arg keeps the function pure for tests).
 */
export function buildOutreachQueue(
  leads: readonly LeadInput[],
  policy: QueuePolicy = resolveQueuePolicy(),
): OutreachQueueEntry[] {
  const ranked = leads
    .map(scoreLead)
    .filter((s) => s.score >= policy.minScore)
    .sort(compareByIntent);

  const capped = policy.limit > 0 ? ranked.slice(0, policy.limit) : ranked;
  return capped.map((entry, index) => ({ ...entry, rank: index + 1 }));
}
