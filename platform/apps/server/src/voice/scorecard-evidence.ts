/**
 * The #96 ↔ #114 seam (pure): turn classified customer-voice evidence into the venture scorecard's
 * **problemSeverity** dimension. Post-launch voice (real users reacting to a shipped product) is the most
 * honest evidence of whether the problem is actually acute + frequent — so it overlays `problemSeverity`,
 * the way #101 demand overlays `willingnessToPay`. With no evidence the caller passes `null` and the
 * dimension is left untouched (default-OFF: the scorecard is byte-for-byte unchanged).
 */
import type { PersonaScorecard, RubricDimension } from "../venture/rubric.js";
import type { ChurnRisk, Sentiment } from "./classify.js";

/** The single rubric dimension customer voice evidences. */
export const VOICE_DIMENSION: RubricDimension = "problemSeverity";

/** One piece of customer-voice evidence the scorecard consumes (a reduced `voice_insight`). */
export interface VoiceEvidence {
  sentiment: Sentiment;
  churnRisk: ChurnRisk;
  npsScore?: number | null;
}

const SENTIMENT_DELTA: Record<Sentiment, number> = { positive: 3, neutral: 0, negative: -3 };
const CHURN_DELTA: Record<ChurnRisk, number> = { low: 1, medium: -1, high: -3 };

function clamp10(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/**
 * Reduce voice evidence to a 0–10 problem-severity score. Each signal starts at a neutral 5 and is
 * pushed by its sentiment + churn-risk (and nudged by an NPS score when present), then averaged across
 * all signals (volume-honest, not strongest-dominates — one furious user is not the whole story, but a
 * pattern of them is). Empty evidence → neutral 5 (the caller guards empty with `null`, so the overlay
 * is skipped entirely; a direct call still gets a sane neutral value).
 */
export function voiceDimensionScore(evidence: VoiceEvidence[]): number {
  if (evidence.length === 0) return 5;
  const sum = evidence.reduce((acc, e) => {
    let s = 5 + SENTIMENT_DELTA[e.sentiment] + CHURN_DELTA[e.churnRisk];
    if (typeof e.npsScore === "number") s += (e.npsScore - 7) * 0.5;
    return acc + clamp10(s);
  }, 0);
  return clamp10(sum / evidence.length);
}

/** Return a copy of the combined scorecard with only the problem-severity dimension replaced. */
export function overlayVoiceDimension(combined: PersonaScorecard, voiceScore: number): PersonaScorecard {
  return { ...combined, [VOICE_DIMENSION]: clamp10(voiceScore) };
}
