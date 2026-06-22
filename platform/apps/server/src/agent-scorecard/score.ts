/**
 * Per-agent scorecard builder (issue #593). Pure: `buildScorecard` is a deterministic function of its input —
 * same events + activity in, same {@link Scorecard} out, every time. No clock, no randomness, no IO.
 *
 * The model is intentionally legible (sum attribution per agent, blend revenue with discounted pipeline, then
 * normalize to a 0–100 cohort score) rather than opaque, because the whole point of #593 is to let a human SEE
 * which agent drove paying customers and trust the ranking. Every figure on an {@link AgentScorecard} is
 * reconstructable from the agent's own pipeline/revenue/conversion/touch counts.
 *
 *   - influenceUsd = revenueUsd + {@link DEFAULT_PIPELINE_WEIGHT} × pipelineUsd  (pipeline is real but unrealized,
 *     so it counts for a fraction of booked revenue when blending the single number we rank by).
 *   - score        = round(100 × influenceUsd / maxInfluenceUsd)                  (the cohort leader scores 100;
 *     an all-zero cohort scores 0 — never NaN).
 */

import type {
  AgentActivity,
  AgentScorecard,
  ChannelStat,
  ConversionEvent,
  Scorecard,
  ScorecardInput,
  ScorecardTotals,
} from "./types.js";

/** Default weight applied to pipeline USD when blending it into the single influence figure. Pipeline is real but unrealized. */
export const DEFAULT_PIPELINE_WEIGHT = 0.3;

/** Which figure the cohort is ranked by. `influence` (the default) blends revenue with discounted pipeline. */
export type RankBy = "influence" | "revenue" | "pipeline" | "conversions";

export interface ScorecardOptions {
  /**
   * Weight applied to pipeline USD when computing `influenceUsd` (and therefore the score). Clamped to [0, 1];
   * an out-of-range or non-finite value falls back to {@link DEFAULT_PIPELINE_WEIGHT}.
   */
  pipelineWeight?: number;
  /** Ranking key. Default `"influence"`. */
  rankBy?: RankBy;
}

/** A non-negative money/count value from optional/untrusted input: coerce non-finite or negative to 0. */
function nonNeg(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Trim a channel/agent key; an empty one becomes the explicit `unknown` bucket so nothing is silently dropped. */
function normChannel(raw: string): string {
  const t = raw.trim();
  return t.length > 0 ? t : "unknown";
}

/** Round to whole cents so floating-point blends (pipelineWeight × USD) never leak long binary tails into output. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function resolvePipelineWeight(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) return DEFAULT_PIPELINE_WEIGHT;
  return raw;
}

/** Mutable per-agent accumulator built up while folding the event + activity lists. */
interface AgentAccumulator {
  agentId: string;
  revenueUsd: number;
  pipelineUsd: number;
  conversions: number;
  revenueConversions: number;
  customers: Set<string>;
  touches: number;
  /** channel → its rolling {@link ChannelStat}. */
  channels: Map<string, ChannelStat>;
}

function emptyAccumulator(agentId: string): AgentAccumulator {
  return {
    agentId,
    revenueUsd: 0,
    pipelineUsd: 0,
    conversions: 0,
    revenueConversions: 0,
    customers: new Set<string>(),
    touches: 0,
    channels: new Map<string, ChannelStat>(),
  };
}

function channelOf(acc: AgentAccumulator, channel: string): ChannelStat {
  let stat = acc.channels.get(channel);
  if (!stat) {
    stat = { channel, pipelineUsd: 0, revenueUsd: 0, conversions: 0, touches: 0 };
    acc.channels.set(channel, stat);
  }
  return stat;
}

/** Fold one conversion event into its agent's accumulator. Events with a blank agentId can't be attributed → skipped. */
function applyEvent(byAgent: Map<string, AgentAccumulator>, event: ConversionEvent): void {
  const agentId = event.agentId.trim();
  if (agentId.length === 0) return;
  const amount = nonNeg(event.amountUsd);
  const channel = normChannel(event.channel);

  let acc = byAgent.get(agentId);
  if (!acc) {
    acc = emptyAccumulator(agentId);
    byAgent.set(agentId, acc);
  }

  acc.conversions += 1;
  const stat = channelOf(acc, channel);
  stat.conversions += 1;
  if (event.kind === "revenue") {
    acc.revenueUsd += amount;
    acc.revenueConversions += 1;
    stat.revenueUsd += amount;
  } else {
    acc.pipelineUsd += amount;
    stat.pipelineUsd += amount;
  }
  const customerId = event.customerId?.trim();
  if (customerId) acc.customers.add(customerId);
}

/** Fold one activity row into its agent's accumulator (and the per-channel touch count). Blank agentId → skipped. */
function applyActivity(byAgent: Map<string, AgentAccumulator>, activity: AgentActivity): void {
  const agentId = activity.agentId.trim();
  if (agentId.length === 0) return;
  const touches = Math.floor(nonNeg(activity.touches));
  if (touches === 0) return;
  const channel = normChannel(activity.channel);

  let acc = byAgent.get(agentId);
  if (!acc) {
    acc = emptyAccumulator(agentId);
    byAgent.set(agentId, acc);
  }
  acc.touches += touches;
  channelOf(acc, channel).touches += touches;
}

/** Order channels by realized revenue, then pipeline, then name — a total, deterministic order. */
function compareChannels(a: ChannelStat, b: ChannelStat): number {
  if (b.revenueUsd !== a.revenueUsd) return b.revenueUsd - a.revenueUsd;
  if (b.pipelineUsd !== a.pipelineUsd) return b.pipelineUsd - a.pipelineUsd;
  return a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0;
}

function fmtUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** Build the one-line headline of an agent's attribution. */
function summarize(card: Omit<AgentScorecard, "summary" | "rank" | "score">): string {
  if (card.conversions === 0) {
    return `${fmtUsd(0)} influenced — no conversions attributed yet`;
  }
  const via = card.topChannel ? ` (top channel: ${card.topChannel})` : "";
  const cust = card.influencedCustomers > 0 ? `, ${card.influencedCustomers} customer(s)` : "";
  return `${fmtUsd(card.revenueUsd)} revenue + ${fmtUsd(card.pipelineUsd)} pipeline across ${card.conversions} conversion(s)${cust}${via}`;
}

/** The ranking comparator for the chosen key; every key falls back to revenue → pipeline → agentId so the order is total. */
function rankComparator(rankBy: RankBy): (a: AgentScorecard, b: AgentScorecard) => number {
  const primary: Record<RankBy, (c: AgentScorecard) => number> = {
    influence: (c) => c.influenceUsd,
    revenue: (c) => c.revenueUsd,
    pipeline: (c) => c.pipelineUsd,
    conversions: (c) => c.conversions,
  };
  const key = primary[rankBy];
  return (a, b) => {
    if (key(b) !== key(a)) return key(b) - key(a);
    if (b.revenueUsd !== a.revenueUsd) return b.revenueUsd - a.revenueUsd;
    if (b.pipelineUsd !== a.pipelineUsd) return b.pipelineUsd - a.pipelineUsd;
    return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
  };
}

/**
 * Aggregate a workspace's conversion events + agent activity into a ranked, conversion-tied {@link Scorecard}.
 *
 * Each agent's pipeline/revenue is summed from the events that credit them, blended into a single `influenceUsd`
 * (revenue + discounted pipeline), then normalized to a 0–100 cohort `score` (leader = 100). Agents are ranked by
 * `options.rankBy` (default `influence`); ties always break the same way, so the order is deterministic.
 *
 * Pure: pass an explicit {@link ScorecardOptions} to keep it independent of any environment.
 */
export function buildScorecard(input: ScorecardInput, options: ScorecardOptions = {}): Scorecard {
  const pipelineWeight = resolvePipelineWeight(options.pipelineWeight);
  const rankBy = options.rankBy ?? "influence";

  const byAgent = new Map<string, AgentAccumulator>();
  for (const event of input.events) applyEvent(byAgent, event);
  for (const activity of input.activities) applyActivity(byAgent, activity);

  // First pass: materialize each accumulator into a scorecard sans score/rank (score needs the cohort max).
  const partial = [...byAgent.values()].map((acc) => {
    const revenueUsd = round2(acc.revenueUsd);
    const pipelineUsd = round2(acc.pipelineUsd);
    const influenceUsd = round2(revenueUsd + pipelineWeight * pipelineUsd);
    const channels = [...acc.channels.values()]
      .map((c) => ({
        channel: c.channel,
        pipelineUsd: round2(c.pipelineUsd),
        revenueUsd: round2(c.revenueUsd),
        conversions: c.conversions,
        touches: c.touches,
      }))
      .sort(compareChannels);
    const topChannel = channels.length > 0 && acc.conversions > 0 ? (channels[0]?.channel ?? null) : null;
    const conversionRate = acc.touches > 0 ? round2(acc.revenueConversions / acc.touches) : 0;
    const base = {
      agentId: acc.agentId,
      revenueUsd,
      pipelineUsd,
      influenceUsd,
      conversions: acc.conversions,
      revenueConversions: acc.revenueConversions,
      influencedCustomers: acc.customers.size,
      touches: acc.touches,
      conversionRate,
      channels,
      topChannel,
    };
    return { ...base, summary: summarize(base) };
  });

  const maxInfluence = partial.reduce((m, c) => Math.max(m, c.influenceUsd), 0);

  const agents: AgentScorecard[] = partial
    .map((c) => ({
      ...c,
      score: maxInfluence > 0 ? Math.round((100 * c.influenceUsd) / maxInfluence) : 0,
      rank: 0,
    }))
    .sort(rankComparator(rankBy))
    .map((c, index) => ({ ...c, rank: index + 1 }));

  const totals: ScorecardTotals = {
    revenueUsd: round2(agents.reduce((s, a) => s + a.revenueUsd, 0)),
    pipelineUsd: round2(agents.reduce((s, a) => s + a.pipelineUsd, 0)),
    influenceUsd: round2(agents.reduce((s, a) => s + a.influenceUsd, 0)),
    conversions: agents.reduce((s, a) => s + a.conversions, 0),
    agents: agents.length,
  };

  return { agents, totals };
}
