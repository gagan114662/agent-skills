/**
 * Daily agent standup digest config (issue #589). Deliberately **self-contained**: the master switch and the
 * per-section item cap are read directly from the process environment, so this feature adds NO edits to the
 * shared `config/schema.ts` barrel — keeping the #589 change set free of parallel-merge conflicts with
 * sibling branches (same pattern as the #620 growth report and #670 spend-cap governor).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing produces
 * no digests, and the (deliberately un-wired) generate path is inert until `STANDUP_DIGEST_ENABLED` is set.
 */

/** Defaults applied when the corresponding env var is unset or invalid. */
export const STANDUP_DIGEST_DEFAULTS = {
  enabled: false,
  /** How many entries to list per section (shipped / decisions / blockers / next) per agent. */
  maxItemsPerSection: 5,
} as const;

export interface StandupDigestCaps {
  /** Master switch for digest generation. OFF by default. */
  enabled: boolean;
  /** Maximum entries surfaced per section, per agent (>= 1). */
  maxItemsPerSection: number;
}

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a positive integer env value with a floor of 1; a missing/invalid value keeps the default. */
function envPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.trunc(n));
}

/** Resolve the standup-digest caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveStandupDigestCaps(env: NodeJS.ProcessEnv = process.env): StandupDigestCaps {
  return {
    enabled: envFlag(env.STANDUP_DIGEST_ENABLED),
    maxItemsPerSection: envPositiveInt(
      env.STANDUP_DIGEST_MAX_ITEMS_PER_SECTION,
      STANDUP_DIGEST_DEFAULTS.maxItemsPerSection,
    ),
  };
}
