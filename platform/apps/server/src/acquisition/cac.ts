/**
 * Acquisition execution — CAC & conversion reporting (issue #189, ADR-0189, AC5).
 *
 * Every channel reports its cost and its conversions into the founder brief (#173). Per premortem
 * #200 §2 ("self-reported metrics are fiction"), the numbers here are grounded in EXTERNAL receipts:
 * spend comes from provider spend receipts (what the ad platform actually charged) and conversions
 * come from externally-verified events (growth `conversion` events with a real source). A CAC computed
 * from a self-reported conversion count is labeled `verified:false` so the brief can mark it UNVERIFIED
 * and never let it drive a kill/scale decision alone.
 *
 * All pure: the reader in `default.ts` gathers the receipts; this file does the arithmetic.
 */

import type { AcquisitionChannel } from "./decide.js";

/** One channel's spend in the window, from provider spend receipts (external). */
export interface ChannelSpend {
  channel: AcquisitionChannel;
  spentCents: number;
}

/** Per-channel conversions in the window. `verified` = the count is from external receipts (#200 §2). */
export interface ChannelConversions {
  channel: AcquisitionChannel;
  conversions: number;
  verified: boolean;
}

export interface ChannelCac {
  channel: AcquisitionChannel;
  spentCents: number;
  conversions: number;
  /** Cost per acquisition in cents, or null when there were no conversions (avoid divide-by-zero). */
  cacCents: number | null;
  /** True only when the conversion count is externally verified — else the brief marks it UNVERIFIED. */
  verified: boolean;
}

/** Cost per acquisition (cents): spend ÷ conversions, or null when there are no conversions. */
export function computeCacCents(spentCents: number, conversions: number): number | null {
  if (conversions <= 0) return null;
  return Math.round(spentCents / conversions);
}

/**
 * Combine per-channel spend + conversions into per-channel CAC. A channel with spend but no recorded
 * conversion yields `cacCents:null` (we don't pretend a CAC exists). `verified` carries through from the
 * conversion source so an estimated count is never silently treated as ground truth.
 */
export function computeChannelCac(
  spend: ChannelSpend[],
  conversions: ChannelConversions[],
): ChannelCac[] {
  const convByChannel = new Map<AcquisitionChannel, ChannelConversions>();
  for (const c of conversions) convByChannel.set(c.channel, c);

  const channels = new Set<AcquisitionChannel>();
  for (const s of spend) channels.add(s.channel);
  for (const c of conversions) channels.add(c.channel);

  const spendByChannel = new Map<AcquisitionChannel, number>();
  for (const s of spend) spendByChannel.set(s.channel, (spendByChannel.get(s.channel) ?? 0) + s.spentCents);

  const rows: ChannelCac[] = [];
  for (const channel of channels) {
    const spentCents = spendByChannel.get(channel) ?? 0;
    const conv = convByChannel.get(channel);
    const conversions = conv?.conversions ?? 0;
    rows.push({
      channel,
      spentCents,
      conversions,
      cacCents: computeCacCents(spentCents, conversions),
      // A CAC is "verified" only when it has conversions AND those conversions are external receipts.
      verified: conversions > 0 && (conv?.verified ?? false),
    });
  }
  // Stable ordering for a deterministic brief: by channel name.
  return rows.sort((a, b) => a.channel.localeCompare(b.channel));
}

/** The acquisition section the founder brief renders (AC5). Optional on the brief input — default-OFF. */
export interface AcquisitionBriefView {
  /** Total real spend across channels in the window (external receipts), cents. */
  totalSpentCents: number;
  /** Total externally-verified conversions across channels. */
  totalConversions: number;
  /** Blended CAC (total spend ÷ total verified conversions), cents, or null. */
  blendedCacCents: number | null;
  /** Whether the blended CAC rests entirely on external receipts (else the brief flags UNVERIFIED). */
  verified: boolean;
  perChannel: ChannelCac[];
  /** Channels whose latest publish failed and surfaced (AC3) — names only. */
  failingChannels: string[];
}

/** Roll per-channel CAC up into the brief view (AC5). Blended CAC uses only verified conversions. */
export function buildAcquisitionBriefView(
  spend: ChannelSpend[],
  conversions: ChannelConversions[],
  failingChannels: string[] = [],
): AcquisitionBriefView {
  const perChannel = computeChannelCac(spend, conversions);
  const totalSpentCents = perChannel.reduce((sum, r) => sum + r.spentCents, 0);
  const verifiedConversions = perChannel
    .filter((r) => r.verified)
    .reduce((sum, r) => sum + r.conversions, 0);
  const totalConversions = perChannel.reduce((sum, r) => sum + r.conversions, 0);
  const blendedCacCents = computeCacCents(totalSpentCents, verifiedConversions);
  return {
    totalSpentCents,
    totalConversions,
    blendedCacCents,
    // Blended CAC is verified only when there is at least one verified conversion and no unverified
    // conversion is being counted toward the blend.
    verified: verifiedConversions > 0 && verifiedConversions === totalConversions,
    perChannel,
    failingChannels,
  };
}
