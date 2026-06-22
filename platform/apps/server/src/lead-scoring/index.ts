/**
 * Lead scoring (issue #611) — module barrel: import everything from here.
 *
 * The problem #611 fixes: agents treat all leads equally and waste effort on low-intent ones. The shape of
 * the fix in code, end to end:
 *
 *   1. Score one lead (explainably):     const s = scoreLead(lead);        // → s.score (0–100) + s.factors
 *   2. Or rank the whole pipeline:        const q = buildOutreachQueue(leads); // → ordered by intent, ranked
 *   3. Work `q` top-down:                 agents take rank 1 first; `entry.summary` / `entry.factors` say why.
 *
 * "Explainable" is not decoration: `scoreLead` returns the exact list of point-attributed factors whose sum
 * is the score, so any rank in the queue can be justified line by line. See {@link explainScore} for a
 * ready-made human rendering.
 *
 * Self-contained pure library (no IO, no clock, no route/schema/migration wiring) — same conflict-free shape
 * as #674 content-guard and #670 budget-governor.
 */

export * from "./types.js";
export * from "./score.js";
export * from "./queue.js";
export { resolveQueuePolicy, BAND_MIN_SCORE, type QueuePolicy } from "./caps.js";

import type { LeadScore } from "./types.js";

/**
 * Render a {@link LeadScore} as human-readable explanation lines: the headline summary, then one bullet per
 * contributing factor with its signed points and reason. This is the "why did this lead rank here?" answer in
 * plain text — for a CLI, an approval card, or an agent's own reasoning trace.
 */
export function explainScore(score: LeadScore): string[] {
  const lines = [score.summary];
  for (const f of score.factors) {
    const sign = f.points >= 0 ? "+" : "";
    lines.push(`  ${sign}${f.points} ${f.label} — ${f.detail}`);
  }
  return lines;
}
