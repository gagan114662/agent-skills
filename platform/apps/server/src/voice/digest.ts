/**
 * The weekly voice-of-customer digest (#114, ADR-0114) — **pure**. Given the already-aggregated voice
 * metrics + the count of tickets needing a human, compose the digest the Founder Console (#104) surfaces
 * and the agent drafts. No IO, no clock (the window is passed in) — so it is unit-tested in isolation.
 */
import type { Sentiment } from "./classify.js";
import type { VoiceMetrics } from "./metrics.js";

export interface VoiceDigestTheme {
  category: string;
  count: number;
}

export interface VoiceDigestInput {
  windowDays: number;
  metrics: VoiceMetrics;
  ticketsNeedingHuman: number;
  /** Optional pre-computed themes; when omitted they are derived from `metrics.byCategory` (top 3). */
  topThemes?: VoiceDigestTheme[];
}

export interface VoiceDigest {
  windowDays: number;
  headline: string;
  totalSignals: number;
  npsScore: number | null;
  sentiment: Record<Sentiment, number>;
  churnHigh: number;
  ticketsNeedingHuman: number;
  topThemes: VoiceDigestTheme[];
}

/** Top-N categories by frequency, ties broken by category name (deterministic). */
function topThemesFrom(byCategory: Record<string, number>, n: number): VoiceDigestTheme[] {
  return Object.entries(byCategory)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
    .slice(0, n);
}

export function buildVoiceDigest(input: VoiceDigestInput): VoiceDigest {
  const { windowDays, metrics, ticketsNeedingHuman } = input;
  const topThemes = input.topThemes ?? topThemesFrom(metrics.byCategory, 3);
  const churnHigh = metrics.churnRisk.high;
  const npsScore = metrics.nps.score;

  const headline =
    `${metrics.total} customer ${metrics.total === 1 ? "signal" : "signals"} in the last ${windowDays}d` +
    ` · NPS ${npsScore === null ? "n/a" : npsScore}` +
    ` · ${churnHigh} high-churn-risk` +
    ` · ${ticketsNeedingHuman} ${ticketsNeedingHuman === 1 ? "ticket" : "tickets"} need a human`;

  return {
    windowDays,
    headline,
    totalSignals: metrics.total,
    npsScore,
    sentiment: metrics.sentiment,
    churnHigh,
    ticketsNeedingHuman,
    topThemes,
  };
}
