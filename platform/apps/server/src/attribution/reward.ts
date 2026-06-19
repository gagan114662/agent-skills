import type { ArtifactRevenue, AttributedRevenueEvent } from "./chain.js";

/**
 * The revenue LEARNING SIGNAL (#390, ADR-0390) — the "learn" step of the autonomous loop (epic #403).
 *
 * #386 produces attributed revenue per artifact / channel (the chain: artifact -> exposure -> signup ->
 * payment, credited by happened-before, every dollar backed by an external receipt). This module turns
 * that REWARD into a RANKING the fleet's prioritization consumes: "more of what earns, less of what
 * doesn't." It is the L3 law made operational — rank by revenue-weighted outcome — feeding the existing
 * #283 SkillOpt cluster ranking (which task an agent invests its one self-improvement cycle on).
 *
 * Pure: no IO, no clock. It rewards ONLY receipted dollars (L1): the input is the `attributed` projection,
 * which #386 already guarantees is verified + caused. Un-attributed / unverified revenue never reaches
 * here (it lands in `unattributed`), so the signal can never be fabricated.
 *
 * The DEPENDENCY (per #390): the learning only runs on REAL receipts. If the projection yields zero
 * attributed events the reward is EMPTY and {@link reweightClustersByRevenue} returns the input order
 * unchanged — no fabricated signal, no reweight. When the flag is off the caller never builds a reward,
 * so today's frequency-only ordering is byte-for-byte preserved.
 */

/** A normalized per-channel reward weight derived from receipted dollars. The fleet's learning signal. */
export interface ChannelReward {
  /** The exposure channel (seo | social | email | ads | ...) — the unit the fleet steers by. */
  channel: string;
  /** Attributed cents this channel earned across the projection window (the raw reward). */
  attributedCents: number;
  /** Share of total attributed cents in [0, 1] — the normalized reward weight. */
  weight: number;
}

/**
 * The revenue reward, keyed by channel. `byChannel` is sorted by attributed dollars descending (the most
 * revenue-producing channel first). `isEmpty` is true iff no attributed dollars exist — the explicit
 * "no receipts ⇒ no learning" signal the caller checks before reweighting anything.
 */
export interface RevenueReward {
  byChannel: ChannelReward[];
  /** Total attributed cents across all channels (0 ⇒ no receipts ⇒ no reweight). */
  totalCents: number;
  /** True iff there is nothing to learn from yet (no attributed receipts). */
  isEmpty: boolean;
  /** Look up a channel's normalized weight in [0, 1]; 0 for an unknown / unrewarded channel. */
  weightFor(channel: string): number;
}

/**
 * Compute the revenue reward per channel from #386's attributed events (receipt-backed only, L1). Rolls
 * dollars up per channel, sorts by dollars descending, and normalizes to a [0, 1] weight (share of total).
 * Zero events ⇒ an EMPTY reward (`isEmpty: true`, every weight 0) — the honest "no receipts, no signal".
 * Pure + total.
 */
export function revenueRewardByChannel(events: readonly AttributedRevenueEvent[]): RevenueReward {
  const centsByChannel = new Map<string, number>();
  let totalCents = 0;
  for (const e of events) {
    // Defensive: a non-finite / negative amount can never be a reward (it is not a receipted dollar).
    if (!Number.isFinite(e.amountCents) || e.amountCents <= 0) continue;
    centsByChannel.set(e.channel, (centsByChannel.get(e.channel) ?? 0) + e.amountCents);
    totalCents += e.amountCents;
  }

  const byChannel: ChannelReward[] =
    totalCents > 0
      ? [...centsByChannel.entries()]
          .map(([channel, attributedCents]) => ({
            channel,
            attributedCents,
            weight: attributedCents / totalCents,
          }))
          .sort((a, b) => b.attributedCents - a.attributedCents || a.channel.localeCompare(b.channel))
      : [];

  const weights = new Map(byChannel.map((c) => [c.channel, c.weight]));
  return {
    byChannel,
    totalCents,
    isEmpty: totalCents <= 0,
    weightFor: (channel: string) => weights.get(channel) ?? 0,
  };
}

/**
 * Convenience: build the reward straight from #386's per-artifact rollup (`rollupByArtifact`). Same math,
 * keyed by the artifact's channel. Pure.
 */
export function revenueRewardFromRollup(rollup: readonly ArtifactRevenue[]): RevenueReward {
  return revenueRewardByChannel(
    rollup.map((r) => ({
      // A synthetic event per rollup row carrying just the fields the reward reads (channel + cents).
      providerEventId: "",
      artifactId: r.artifactId,
      artifactKind: r.artifactKind,
      channel: r.channel,
      trackingRef: "",
      amountCents: r.attributedCents,
      currency: r.currency,
      exposureAtMs: 0,
      paidAtMs: 0,
    })),
  );
}

/** A cluster carrying just the fields the reweight reads: its key and a representative task to classify. */
export interface RankableCluster {
  key: string;
  representativeTask: string;
}

/**
 * Map a cluster to the revenue channel its work belongs to, by structural keyword match on the (already
 * sanitized) representative task. Returns null when no channel keyword is present (the cluster earns no
 * revenue weight — it is left at its baseline frequency rank). This is the ONLY heuristic in the module
 * and it is deliberately conservative: an unmatched cluster is never penalized, only un-boosted.
 */
const CHANNEL_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["seo", ["seo", "search", "blog", "page", "keyword", "rank", "organic"]],
  ["social", ["social", "post", "tweet", "thread", "linkedin", "instagram"]],
  ["email", ["email", "newsletter", "drip", "campaign", "inbox"]],
  ["ads", ["ad", "ads", "campaign", "creative", "ppc", "adwords"]],
];

export function channelForCluster(cluster: RankableCluster): string | null {
  const text = ` ${cluster.representativeTask.toLowerCase()} `;
  for (const [channel, words] of CHANNEL_KEYWORDS) {
    for (const w of words) {
      if (text.includes(` ${w} `) || text.includes(` ${w}s `)) return channel;
    }
  }
  return null;
}

export interface ReweightOptions {
  /**
   * How strongly revenue reweights the frequency order, in [0, ...). 0 ⇒ no reweight (frequency only).
   * The reweighted score is `frequencyShare + strength * revenueWeight`, where `frequencyShare` is a
   * fractional in (0, 1] decaying by rank position and `revenueWeight` is the channel's share of dollars
   * in [0, 1]. At the default strength 1, a clearly higher-earning channel overrides a one-rank frequency
   * lead ("more of what earns"); ties (and a flat revenue field) preserve the frequency order. Default 1.
   */
  strength?: number;
  /** Classify a cluster to a channel (defaults to {@link channelForCluster}). Injectable for tests. */
  channelOf?: (cluster: RankableCluster) => string | null;
}

/** A cluster after revenue reweighting, carrying the score it was ranked by (for traceability / display). */
export interface RankedCluster<C extends RankableCluster> {
  cluster: C;
  /** The channel the cluster mapped to, or null if it earned no revenue weight. */
  channel: string | null;
  /** The revenue weight applied (0 for an unmatched / unrewarded channel). */
  revenueWeight: number;
  /** The final score it was ranked by (frequency boosted by revenue). */
  score: number;
}

/**
 * Reweight mined task clusters by attributed revenue so the fleet prioritizes revenue-producing work
 * ("more of what earns"). The clusters arrive in frequency order (most-recurring first, #283); this boosts
 * each by the normalized revenue weight of the channel its work belongs to, then re-sorts descending.
 *
 * The "no receipts ⇒ no learning" dependency is explicit and FAIL-SAFE: when `reward.isEmpty` (zero
 * attributed receipts) the input order is returned UNCHANGED — no fabricated signal, no reweight. Stable:
 * ties keep the incoming frequency order. Pure + total; does not mutate the input.
 *
 * The frequency component uses each cluster's rank position (1st gets the highest base share), so the
 * function needs no count field — it trusts the caller's frequency ordering and only perturbs it by
 * revenue. A cluster that maps to no channel keeps its baseline position (revenueWeight 0).
 */
export function reweightClustersByRevenue<C extends RankableCluster>(
  clusters: readonly C[],
  reward: RevenueReward,
  opts: ReweightOptions = {},
): RankedCluster<C>[] {
  const strength = opts.strength ?? 1;
  const channelOf = opts.channelOf ?? channelForCluster;
  const n = clusters.length;

  // No receipts (or nothing to perturb) ⇒ return the input order unchanged. This is the #390 dependency:
  // the learning runs ONLY on real receipts; an empty reward reweights nothing.
  if (reward.isEmpty || strength <= 0 || n === 0) {
    return clusters.map((cluster, i) => ({
      cluster,
      channel: null,
      revenueWeight: 0,
      // Strictly-descending baseline score so a no-op caller sees the input order preserved.
      score: n - i,
    }));
  }

  const ranked = clusters.map((cluster, i) => {
    // Frequency share decays by rank position into (0, 1] — adjacent ranks differ by < 1, so a strong
    // revenue weight (also in [0, 1], scaled by `strength`) can override a one-rank frequency lead.
    const frequencyShare = (n - i) / n;
    const channel = channelOf(cluster);
    const revenueWeight = channel ? reward.weightFor(channel) : 0;
    const score = frequencyShare + strength * revenueWeight;
    return { cluster, channel, revenueWeight, score, _i: i };
  });

  // Sort by reweighted score descending; ties keep incoming frequency order (stable on original index).
  ranked.sort((a, b) => b.score - a.score || a._i - b._i);
  return ranked.map(({ _i, ...rest }) => rest);
}
