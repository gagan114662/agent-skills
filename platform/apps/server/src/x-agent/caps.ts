/**
 * Configuration for the X posting + engagement agent (issue #596). Deliberately **self-contained**: the master
 * switch and the single user-supplied access token are read straight from the process environment, so this
 * feature adds NO edit to the shared `config/schema.ts` barrel and stays free of parallel-merge conflicts with
 * sibling branches (the proven #670/#674/#587/#742 pattern).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs an
 * inert agent that never posts or engages. Two independent gates must both be satisfied before a real adapter
 * could ever touch a network:
 *   1. `X_AGENT_ENABLED` must be truthy (the master switch), AND
 *   2. `X_AGENT_TOKEN` must be present.
 * Even with both, the shipped real adapter is a no-op because no live transport is wired (see `provider.ts`) —
 * so this change set cannot live-post. The credential is a token the HUMAN supplied out-of-band; this module
 * never collects passwords nor performs OAuth itself (the issue's hard guardrail).
 */

export interface XAgentCaps {
  /** Master switch for the agent. OFF by default. */
  enabled: boolean;
  /**
   * The user-supplied X access token, or null when none is configured. Opaque to this module — it is forwarded
   * to the adapter, never minted or parsed here.
   */
  credential: string | null;
}

export const X_AGENT_DEFAULTS: XAgentCaps = {
  enabled: false,
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

/** Resolve the agent caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveXAgentCaps(env: NodeJS.ProcessEnv = process.env): XAgentCaps {
  return {
    enabled: envFlag(env.X_AGENT_ENABLED),
    credential: envToken(env.X_AGENT_TOKEN),
  };
}
