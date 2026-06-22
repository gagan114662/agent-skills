/**
 * Configuration for the LinkedIn outreach agent module (issue #595). Deliberately **self-contained**: the master
 * switch, the daily send limit, and the access token are read straight from the process environment, so this
 * feature adds NO edit to the shared `config/schema.ts` barrel and stays free of parallel-merge conflicts with
 * sibling branches (the proven #670/#674/#587 pattern).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs an inert
 * connector that never sends. Two independent gates must both be satisfied before a real adapter could ever
 * touch a network:
 *   1. `LINKEDIN_OUTREACH_ENABLED` must be truthy (the master switch), AND
 *   2. the access token must be present.
 * Even with both, the shipped real adapter is a no-op because no live transport is wired (see `provider.ts`) — so
 * this change set cannot live-send. The token is supplied by the HUMAN out-of-band; this module never collects
 * passwords nor performs OAuth itself (the issue's hard guardrail).
 */

export interface LinkedInOutreachCaps {
  /** Master switch for the connector. OFF by default. */
  enabled: boolean;
  /** Max touches that may be SENT per workspace per UTC day. The "respects daily limits" guardrail. */
  dailySendLimit: number;
  /** The user-supplied LinkedIn access token, or null when none is configured. Opaque — forwarded, never minted. */
  credential: string | null;
}

/** Conservative default daily cap — well under LinkedIn's invite throttles, tunable via env. */
export const DEFAULT_DAILY_SEND_LIMIT = 20;

export const LINKEDIN_OUTREACH_DEFAULTS: LinkedInOutreachCaps = {
  enabled: false,
  dailySendLimit: DEFAULT_DAILY_SEND_LIMIT,
  credential: null,
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

/** Parse a positive-integer env limit, falling back to `fallback` for absent/blank/invalid/non-positive values. */
function envLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolve the connector caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveLinkedInOutreachCaps(
  env: NodeJS.ProcessEnv = process.env,
): LinkedInOutreachCaps {
  return {
    enabled: envFlag(env.LINKEDIN_OUTREACH_ENABLED),
    dailySendLimit: envLimit(env.LINKEDIN_OUTREACH_DAILY_LIMIT, DEFAULT_DAILY_SEND_LIMIT),
    credential: envToken(env.LINKEDIN_OUTREACH_TOKEN),
  };
}
