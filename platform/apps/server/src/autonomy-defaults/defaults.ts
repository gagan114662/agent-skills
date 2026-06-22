/**
 * The leaf definitions for the autonomy-by-default policy (issue #727): the capability/channel sets, their
 * resolved-caps shape, and the all-ON default. Kept dependency-free so both the pure policy (`policy.ts`) and the
 * env resolver (`caps.ts`) can import them without a cycle.
 *
 * The all-ON default is the literal encoding of the acceptance criterion "a fresh workspace has all capabilities
 * ON": every capability and channel starts `true` (autonomous), and only an explicit opt-out flips one to `false`.
 */

/**
 * The capability categories an agent acts through. Each is an opt-OUT toggle that defaults ON (autonomous).
 *  - `draft`    — compose/prepare content that stays internal until published.
 *  - `publish`  — publish/post/announce content to an owned surface.
 *  - `outreach` — non-paid outreach: send/email/sms/dm/message a recipient.
 *  - `deploy`   — ship/release/deploy code or config.
 */
export const CAPABILITIES = ["draft", "publish", "outreach", "deploy"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The outreach channels, each an opt-OUT toggle that defaults ON. A disabled channel gates only its own sends. */
export const CHANNELS = ["email", "sms", "social", "slack", "dm", "voice", "push", "web"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The resolved per-workspace opt-out state: `true` ⇒ capability/channel is ON (autonomous), `false` ⇒ dialed off. */
export interface AutonomyCaps {
  capabilities: Record<Capability, boolean>;
  channels: Record<Channel, boolean>;
}

function allOn<T extends string>(keys: readonly T[]): Record<T, boolean> {
  const out = {} as Record<T, boolean>;
  for (const k of keys) out[k] = true;
  return out;
}

/**
 * The default caps for a fresh or existing workspace: EVERY capability and channel ON. This is the data-layer
 * default the issue's acceptance criterion rests on ("all capabilities ON out of the box, zero switch-flipping").
 */
export const AUTONOMY_DEFAULTS_ALL_ON: AutonomyCaps = {
  capabilities: allOn(CAPABILITIES),
  channels: allOn(CHANNELS),
};
