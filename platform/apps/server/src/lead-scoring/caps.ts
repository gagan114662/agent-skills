/**
 * Lead-scoring queue config (issue #611). Deliberately **self-contained** in the manner of the #674
 * content-guard and #670 budget-governor modules: the only tunables are read straight from the process
 * environment, so this feature adds NO edit to the shared `config/schema.ts` barrel and stays free of
 * parallel-merge conflicts with sibling branches.
 *
 * The model weights themselves are NOT env-tunable — they are governed constants in `score.ts` (a retune is a
 * code review, not a deploy knob). What IS tunable is how the OUTREACH QUEUE is cut from the scored leads:
 *
 *   - `LEAD_SCORING_QUEUE_MIN_SCORE` — drop leads below this 0–100 intent score from the queue entirely
 *     (don't waste an agent on a cold lead). Default 0 = include everyone, ranked.
 *   - `LEAD_SCORING_QUEUE_LIMIT`     — cap the queue to the top-N after sorting. Default 0 = no cap.
 */

import type { IntentBand } from "./types.js";

/** The resolved policy that shapes the outreach queue. */
export interface QueuePolicy {
  /** Leads scoring strictly below this are excluded from the queue (0–100). */
  minScore: number;
  /** Keep only the top-N entries after ranking; `0` means no cap. */
  limit: number;
}

/** Band → its inclusive lower score bound, for callers that want to filter/threshold by band name. */
export const BAND_MIN_SCORE: Record<IntentBand, number> = {
  hot: 70,
  warm: 45,
  cool: 20,
  cold: 0,
};

/** Resolve the queue policy from the environment. Pure given its `env` argument. */
export function resolveQueuePolicy(env: NodeJS.ProcessEnv = process.env): QueuePolicy {
  return {
    minScore: parseScore(env.LEAD_SCORING_QUEUE_MIN_SCORE),
    limit: parseLimit(env.LEAD_SCORING_QUEUE_LIMIT),
  };
}

/** Parse a 0–100 score floor; clamp into range; a missing/invalid value means "no floor" (0). */
function parseScore(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** Parse a non-negative top-N cap; a missing/invalid/negative value means "no cap" (0). */
function parseLimit(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}
