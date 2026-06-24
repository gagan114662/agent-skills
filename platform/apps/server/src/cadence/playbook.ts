/**
 * The dogfood growth PLAYBOOK (#416) — a pure, ordered, cyclic list of conservative tasks the autonomous
 * work cadence advances ONE at a time so the fleet keeps working ON ipop.ai's own growth instead of
 * stopping after a single one-shot brief.
 *
 * Every task is **DRAFT-ONLY**: it audits, summarizes, drafts, or reviews and leaves the work in-channel
 * for a human. NONE asks the fleet to send, publish, or spend — anything that leaves the building still
 * goes through the #13 approval gate on the existing brief launch path (the cadence adds no new money or
 * send authority). An eval asserts no goal contains a send/publish/spend verb (see the test), so a future
 * edit that smuggles an outbound verb into a goal fails CI rather than silently shipping autonomy.
 *
 * `lead` is a fleet @handle (matching `marketing/blueprint.ts`: scout/quill/echo/lens/mark/…); the cadence
 * engine briefs that lead via the SAME audited @mention launch path the owner's brief composer uses.
 */

/** One cadence step: which department lead to brief, and the concrete draft-only goal. */
export interface CadenceTask {
  /** The fleet @handle of the department lead to brief (no leading @). */
  lead: string;
  /** Stable outcome bucket used to choose the next experiment from recorded results. */
  outcomeKey: string;
  /** A concrete, safe, DRAFT-ONLY goal — never a send/publish/spend. */
  goal: string;
}

/** One recorded outcome the cadence can learn from. Positive outcomes double down; failures get repaired. */
export interface CadenceOutcome {
  /** Stable bucket matching a task's `outcomeKey` (seo, social, conversion, ...). */
  outcomeKey: string;
  /** Whether the latest observed result worked or failed. */
  result: "worked" | "failed";
  /** Optional external-grounded conversion count; stronger positive evidence wins ties. */
  conversions?: number;
}

/**
 * The cyclic dogfood backlog. Each pass advances the cursor by one (round-robin), so the fleet works one
 * concrete growth task per tick and wraps back to the top — a steady, conservative cadence rather than a
 * burst. Goals are deliberately scoped to analysis/draft/review of ipop.ai's OWN growth.
 */
export const CADENCE_PLAYBOOK: readonly CadenceTask[] = [
  {
    lead: "scout",
    outcomeKey: "seo",
    goal:
      "Audit ipop.ai's homepage SEO and list the top 5 fixes ranked by impact. Findings only — no changes, " +
      "draft the list in-channel for review.",
  },
  {
    lead: "quill",
    outcomeKey: "content",
    goal:
      "Draft one buyer-intent blog post for ipop.ai. Pick a high-intent keyword an AI-marketing buyer would " +
      "search, and write the draft in-channel. Draft only — nothing publishes.",
  },
  {
    lead: "echo",
    outcomeKey: "social",
    goal:
      "Draft 3 social posts (a mix of X and LinkedIn) promoting ipop's latest content. Drafts only — leave " +
      "them in-channel, nothing posts.",
  },
  {
    lead: "lens",
    outcomeKey: "conversion",
    goal:
      "Summarize what we know about ipop.ai's homepage conversion and name the ONE metric to move next, with " +
      "the reasoning. Notes only, in-channel.",
  },
  {
    lead: "mark",
    outcomeKey: "brand",
    goal:
      "Review ipop.ai's homepage copy for brand voice and flag anything that reads off-voice. Notes only — " +
      "draft the flags in-channel.",
  },
];

/** The number of steps in the cyclic playbook. */
export const CADENCE_PLAYBOOK_LENGTH = CADENCE_PLAYBOOK.length;

/**
 * Pure round-robin: the index AFTER advancing `cursor` once over a list of `len` steps. Wraps to 0 at the
 * end. Defensive: a non-positive `len` (empty playbook) yields 0, and a cursor outside `[0, len)` is
 * normalized — so the engine can never index out of range no matter what state it holds.
 */
export function nextTaskIndex(cursor: number, len: number): number {
  if (len <= 0) return 0;
  const normalized = ((Math.trunc(cursor) % len) + len) % len;
  return (normalized + 1) % len;
}

/**
 * Pure: the task at `index` in the cyclic playbook (wrapping). Returns undefined only when the playbook is
 * empty — every finite index otherwise resolves to a task.
 */
export function taskAt(index: number): CadenceTask | undefined {
  const len = CADENCE_PLAYBOOK.length;
  if (len <= 0) return undefined;
  const normalized = ((Math.trunc(index) % len) + len) % len;
  return CADENCE_PLAYBOOK[normalized];
}

/**
 * Pick the next task from recorded outcomes. Positive evidence (especially verified conversions) doubles
 * down on what worked; if nothing worked, the most-failed bucket is revisited for repair. No outcomes keeps
 * the previous round-robin cursor, preserving #416 behavior until a reader is wired.
 */
export function selectTaskIndexFromOutcomes(
  cursor: number,
  outcomes: readonly CadenceOutcome[],
  tasks: readonly CadenceTask[] = CADENCE_PLAYBOOK,
): number {
  if (tasks.length === 0 || outcomes.length === 0) return cursor;

  const scores = new Map<string, number>();
  for (const outcome of outcomes) {
    const key = outcome.outcomeKey.trim();
    if (!key) continue;
    const conversions = Math.max(0, Math.trunc(outcome.conversions ?? 0));
    const delta = outcome.result === "worked" ? 5 + conversions * 10 : -4;
    scores.set(key, (scores.get(key) ?? 0) + delta);
  }
  if (scores.size === 0) return cursor;

  let chosen: { key: string; score: number } | undefined;
  for (const [key, score] of scores) {
    if (score > 0 && (!chosen || chosen.score <= 0 || score > chosen.score)) chosen = { key, score };
  }
  if (!chosen) {
    for (const [key, score] of scores) {
      if (score < 0 && (!chosen || score < chosen.score)) chosen = { key, score };
    }
  }
  if (!chosen) return cursor;

  const index = tasks.findIndex((task) => task.outcomeKey === chosen!.key);
  return index >= 0 ? index : cursor;
}
