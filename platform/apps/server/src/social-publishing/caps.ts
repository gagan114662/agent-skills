/**
 * Configuration for the social publishing connectors module (issue #742). Deliberately **self-contained**: the
 * master switch and the per-platform credential tokens are read straight from the process environment, so this
 * feature adds NO edit to the shared `config/schema.ts` barrel and stays free of parallel-merge conflicts with
 * sibling branches (the proven #670/#674/#587 pattern).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs an inert
 * connector that never posts. Two independent gates must both be satisfied before a real adapter could ever
 * touch a network:
 *   1. `SOCIAL_PUBLISHING_ENABLED` must be truthy (the master switch), AND
 *   2. the platform's credential token must be present.
 * Even with both, the shipped real adapters are no-ops because no live transport is wired (see `provider.ts`) —
 * so this change set cannot live-post. The credential is a token the HUMAN supplied out-of-band; this module
 * never collects passwords nor performs OAuth itself (the issue's hard guardrail).
 */

import type { SocialPlatform } from "./types.js";

export interface SocialPublishingCaps {
  /** Master switch for the connector. OFF by default. */
  enabled: boolean;
  /**
   * The user-supplied access token per platform, or null when none is configured. Opaque to this module — it is
   * forwarded to the adapter, never minted or parsed here.
   */
  credentials: Record<SocialPlatform, string | null>;
}

export const SOCIAL_PUBLISHING_DEFAULTS: SocialPublishingCaps = {
  enabled: false,
  credentials: { tiktok: null, instagram_reels: null, youtube_shorts: null },
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** A trimmed non-empty env value, or null. Treats whitespace-only as absent so a blank secret is "no token". */
function envToken(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Resolve the connector caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveSocialPublishingCaps(
  env: NodeJS.ProcessEnv = process.env,
): SocialPublishingCaps {
  return {
    enabled: envFlag(env.SOCIAL_PUBLISHING_ENABLED),
    credentials: {
      tiktok: envToken(env.SOCIAL_PUBLISHING_TIKTOK_TOKEN),
      instagram_reels: envToken(env.SOCIAL_PUBLISHING_INSTAGRAM_REELS_TOKEN),
      youtube_shorts: envToken(env.SOCIAL_PUBLISHING_YOUTUBE_SHORTS_TOKEN),
    },
  };
}
