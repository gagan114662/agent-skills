/**
 * The outbound-channel catalogue (issue #395). Pure + dependency-free — runs in the no-DB/no-network unit
 * job. This is the source of truth for WHICH channel the fleet connects first and the static metadata that
 * binds a channel to its provider + the env var that carries its (owner-gated) credential.
 *
 * #395 ships exactly ONE channel — the lowest-risk sending domain (Postmark email, #268) — so the fleet
 * can leave the building with a real, reputation-safe surface before any social/ad lane is wired.
 */

import { OUTBOUND_CHANNELS, type OutboundChannel } from "./constants.js";

export { OUTBOUND_CHANNELS };
export type { OutboundChannel };

/**
 * The lowest-risk first channel (#395 §1 / #268): a sending domain via Postmark. Email is owner-reviewed
 * per-send, has built compliance (#189) and deliverability (#268) guards, and — unlike a social timeline —
 * never spends money. It is the safest place to prove "a real send reached a real stranger."
 */
export const LOWEST_RISK_CHANNEL: OutboundChannel = "email_postmark";

export interface ChannelDescriptor {
  /** The channel id. */
  readonly channel: OutboundChannel;
  /** Human label for owner-facing surfaces (never carries internal agent chatter). */
  readonly label: string;
  /** The underlying provider key. */
  readonly provider: string;
  /**
   * The deployment env var that carries the OWNER-GATED live credential. The agent never sets it; the
   * owner runs `fly secrets set <envKey>=...` once. The value is read inline at the send site, never
   * persisted. We expose only the NAME here, never the value.
   */
  readonly credentialEnvKey: string;
  /** Whether a real send on this channel spends money (gates additionally via the #13 money path). */
  readonly spendsMoney: boolean;
}

const DESCRIPTORS: Readonly<Record<OutboundChannel, ChannelDescriptor>> = {
  email_postmark: {
    channel: "email_postmark",
    label: "Email (Postmark)",
    provider: "postmark",
    credentialEnvKey: "POSTMARK_SERVER_TOKEN",
    spendsMoney: false,
  },
};

/** Total guard: is `value` a known outbound channel? Rejects unknown strings (a closed allow-list). */
export function isOutboundChannel(value: unknown): value is OutboundChannel {
  return typeof value === "string" && (OUTBOUND_CHANNELS as readonly string[]).includes(value);
}

/** The descriptor for a channel, or `null` for an unknown one. */
export function getChannelDescriptor(channel: string): ChannelDescriptor | null {
  return isOutboundChannel(channel) ? DESCRIPTORS[channel] : null;
}
