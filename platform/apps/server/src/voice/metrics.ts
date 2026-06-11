/**
 * Customer Voice metrics (#114, ADR-0114) — **pure** aggregation of the classified `voice_insight` rows
 * into the churn/NPS roll-up that feeds the Founder Console (#104) and the portfolio loop (#107). No IO;
 * the IO `service.ts` lists the rows and hands them here.
 */
import type { ChurnRisk, Sentiment, VoiceSourceKind } from "./classify.js";

/** The minimal shape of a `voice_insight` the metrics need (decoupled from the DB row type). */
export interface VoiceInsightLike {
  sentiment: Sentiment;
  churnRisk: ChurnRisk;
  category: string;
  sourceKind: VoiceSourceKind;
  npsScore?: number | null;
}

export interface VoiceMetrics {
  total: number;
  sentiment: Record<Sentiment, number>;
  churnRisk: Record<ChurnRisk, number>;
  nps: {
    /** Number of NPS responses (only `nps` source rows with a numeric score). */
    responses: number;
    promoters: number;
    passives: number;
    detractors: number;
    /** %promoters − %detractors over responses, −100…100; `null` when there are no responses. */
    score: number | null;
  };
  byCategory: Record<string, number>;
}

/** Aggregate the insight rows into the voice metrics. Total + deterministic. */
export function aggregateVoiceMetrics(insights: VoiceInsightLike[]): VoiceMetrics {
  const sentiment: Record<Sentiment, number> = { positive: 0, neutral: 0, negative: 0 };
  const churnRisk: Record<ChurnRisk, number> = { low: 0, medium: 0, high: 0 };
  const byCategory: Record<string, number> = {};
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  let responses = 0;

  for (const i of insights) {
    sentiment[i.sentiment] += 1;
    churnRisk[i.churnRisk] += 1;
    byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
    if (i.sourceKind === "nps" && typeof i.npsScore === "number") {
      responses += 1;
      if (i.npsScore >= 9) promoters += 1;
      else if (i.npsScore >= 7) passives += 1;
      else detractors += 1;
    }
  }

  const score = responses === 0 ? null : Math.round(((promoters - detractors) / responses) * 100);

  return {
    total: insights.length,
    sentiment,
    churnRisk,
    nps: { responses, promoters, passives, detractors, score },
    byCategory,
  };
}
