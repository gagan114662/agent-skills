/**
 * Configuration for the community participation agent (issue #597). Deliberately **self-contained**: the master
 * switch, the per-platform credential tokens, and the anti-spam policy knobs are read straight from the process
 * environment, so this feature adds NO edit to the shared `config/schema.ts` barrel and stays free of
 * parallel-merge conflicts with sibling branches (the proven #670/#674/#587/#742 pattern).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs an inert
 * agent that never fetches and never posts. Two independent gates must both be satisfied before a real adapter
 * could ever touch a network:
 *   1. `COMMUNITY_PARTICIPATION_ENABLED` must be truthy (the master switch), AND
 *   2. the platform's credential token must be present.
 * Even with both, the shipped real adapters are no-ops because no live transport is wired (see `provider.ts`) —
 * so this change set cannot live-fetch or live-post. The credential is a token the HUMAN supplied out-of-band;
 * this module never collects passwords nor performs OAuth itself (the issue's hard guardrail).
 *
 * The anti-spam policy ({@link AntiSpamPolicy}) is the legible, tunable heart of the value-first guarantee. The
 * defaults are deliberately conservative — when in doubt the gate blocks (fail-closed). Operators can loosen a
 * knob via env, but every default errs toward "participate less, help more".
 */

import type { CommunityPlatform } from "./types.js";

/**
 * The anti-spam / relevance policy the gate enforces. All thresholds are conservative by default; the gate is
 * fail-closed, so a missing or malformed knob falls back to the strict default rather than "no limit".
 */
export interface AntiSpamPolicy {
  /** Minimum topic-overlap relevance (0..1) for a thread to be worth replying to at all. */
  minRelevance: number;
  /** Relevance (0..1) at/above which a product mention is considered genuinely relevant (and thus allowed). */
  productMentionRelevance: number;
  /** Maximum fraction (0..1) of recent replies in a community that may mention the product. */
  maxPromoRatio: number;
  /** How many recent replies to weigh when computing the promo ratio and rate limits. */
  historyWindow: number;
  /** Maximum replies allowed in one community within {@link rateWindowHours}. */
  maxRepliesPerWindow: number;
  /** The rolling window, in hours, over which {@link maxRepliesPerWindow} applies. */
  rateWindowHours: number;
  /** Minimum hours to wait after the last reply in a community before replying again (cooldown). */
  minHoursBetweenReplies: number;
  /** Oldest a thread may be (hours) and still be worth a reply — don't necro dead threads. */
  maxThreadAgeHours: number;
  /** Minimum number of words a value-first reply must contain (anything shorter reads as a drive-by). */
  minReplyWords: number;
}

export interface CommunityCaps {
  /** Master switch for the agent. OFF by default. */
  enabled: boolean;
  /**
   * The user-supplied access token per platform, or null when none is configured. Opaque to this module — it is
   * forwarded to the adapter, never minted or parsed here.
   */
  credentials: Record<CommunityPlatform, string | null>;
  /** The anti-spam / relevance policy the gate enforces. */
  policy: AntiSpamPolicy;
}

/** Conservative, fail-closed defaults. Participate sparingly; only ever mention the product when truly relevant. */
export const ANTI_SPAM_DEFAULTS: AntiSpamPolicy = {
  minRelevance: 0.34,
  productMentionRelevance: 0.66,
  maxPromoRatio: 0.25,
  historyWindow: 20,
  maxRepliesPerWindow: 3,
  rateWindowHours: 24,
  minHoursBetweenReplies: 6,
  maxThreadAgeHours: 24 * 14,
  minReplyWords: 20,
};

export const COMMUNITY_DEFAULTS: CommunityCaps = {
  enabled: false,
  credentials: { reddit: null, slack: null, discord: null },
  policy: ANTI_SPAM_DEFAULTS,
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

/**
 * Parse a numeric knob from env, clamped to `[min, max]`, falling back to `fallback` for anything missing or
 * non-finite. Fail-closed: a garbage value becomes the conservative default rather than disabling the limit.
 */
function envNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Resolve the anti-spam policy from env (defaults applied, every knob clamped to a sane range). */
export function resolveAntiSpamPolicy(env: NodeJS.ProcessEnv = process.env): AntiSpamPolicy {
  const d = ANTI_SPAM_DEFAULTS;
  return {
    minRelevance: envNumber(env.COMMUNITY_MIN_RELEVANCE, d.minRelevance, 0, 1),
    productMentionRelevance: envNumber(env.COMMUNITY_PRODUCT_MENTION_RELEVANCE, d.productMentionRelevance, 0, 1),
    maxPromoRatio: envNumber(env.COMMUNITY_MAX_PROMO_RATIO, d.maxPromoRatio, 0, 1),
    historyWindow: Math.round(envNumber(env.COMMUNITY_HISTORY_WINDOW, d.historyWindow, 1, 1000)),
    maxRepliesPerWindow: Math.round(envNumber(env.COMMUNITY_MAX_REPLIES_PER_WINDOW, d.maxRepliesPerWindow, 0, 1000)),
    rateWindowHours: envNumber(env.COMMUNITY_RATE_WINDOW_HOURS, d.rateWindowHours, 0, 24 * 365),
    minHoursBetweenReplies: envNumber(env.COMMUNITY_MIN_HOURS_BETWEEN_REPLIES, d.minHoursBetweenReplies, 0, 24 * 365),
    maxThreadAgeHours: envNumber(env.COMMUNITY_MAX_THREAD_AGE_HOURS, d.maxThreadAgeHours, 0, 24 * 3650),
    minReplyWords: Math.round(envNumber(env.COMMUNITY_MIN_REPLY_WORDS, d.minReplyWords, 1, 10000)),
  };
}

/** Resolve the full agent caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveCommunityCaps(env: NodeJS.ProcessEnv = process.env): CommunityCaps {
  return {
    enabled: envFlag(env.COMMUNITY_PARTICIPATION_ENABLED),
    credentials: {
      reddit: envToken(env.COMMUNITY_REDDIT_TOKEN),
      slack: envToken(env.COMMUNITY_SLACK_TOKEN),
      discord: envToken(env.COMMUNITY_DISCORD_TOKEN),
    },
    policy: resolveAntiSpamPolicy(env),
  };
}
