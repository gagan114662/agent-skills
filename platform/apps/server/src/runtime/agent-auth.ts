import type { HarnessKind } from "./harness.js";
import { isWellFormedClaudeKey } from "../auth/claude-key-validation.js";

/**
 * Subscription-ONLY agent auth (#68, ADR-0068; tightened in #246).
 *
 * A real fleet agent must run on the *owner's own* Claude subscription — **never** an Anthropic API
 * key. #246 (owner decision, 2026-06-15) removed the platform-key fallback entirely: an agent run
 * authenticates with the workspace's connected `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`) or it
 * doesn't run. There is no API-key path for the agent runtime, so an unconnected/expired workspace
 * surfaces "reconnect your Claude" instead of silently falling back to (and charging) an API key.
 *
 * **Compliance invariant — one subscription is never pooled across workspaces.** This function only
 * ever receives ONE workspace's token (resolved per `workspaceId` upstream), so it is structurally
 * incapable of crossing tenants.
 */
export type AgentAuth =
  | { mode: "subscription"; secrets: { CLAUDE_CODE_OAUTH_TOKEN: string } }
  | { mode: "api_key"; secrets: { ANTHROPIC_API_KEY: string } }
  | {
      mode: "none";
      secrets: Record<string, never>;
      /**
       * Plain-language, owner/tenant-facing explanation of WHY there is no auth, when the cause is
       * more specific than "never connected" (e.g. a present-but-malformed workspace token). Safe to
       * surface in a channel prompt or the runtime status — never contains a credential value.
       */
      reason?: string;
    };

/**
 * The loud, plain-language error for a workspace whose CONNECTED token is unusable. This case must
 * never silently fall back to the deployment's credentials (Gemini review on #1590): the tenant's
 * runs would bill the OWNER's account while the tenant's broken connection went unnoticed.
 */
export const MALFORMED_WORKSPACE_TOKEN_REASON =
  "Your workspace's connected Claude token is present but unusable — it looks like a bad paste " +
  "(extra spaces or line breaks). Reconnect it in Settings → Connect Claude to run agents again.";

export interface AgentAuthInput {
  /** The workspace's own Claude subscription token (`claude setup-token`), or null if not connected. */
  subscriptionToken: string | null;
  /**
   * The deployment's Claude SUBSCRIPTION token (#1568, owner decision 2026-07-02): the owner's own
   * `claude setup-token` output set as `CLAUDE_CODE_OAUTH_TOKEN` in the server env (Fly secret). This
   * is the PRIMARY server credential — agents run on the owner's Claude subscription, not an API key.
   * A workspace's own connected token still wins so per-tenant billing is unchanged when connected.
   * Never stored in code or the DB; injected/redacted like every secret.
   */
  envSubscriptionToken?: string | null;
  /**
   * The deployment's Anthropic API key (`ANTHROPIC_API_KEY` in the server env). OPTIONAL FALLBACK
   * only — used when neither a workspace nor a deployment subscription token is available. Never
   * stored in code or the DB. Optional so existing callers keep the #246 subscription-or-nothing
   * behavior.
   */
  envApiKey?: string | null;
}

/** A non-empty, non-whitespace string, else null — a blank stored secret must not count as auth. */
function present(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decide the auth to inject for a session (#1568, owner decision 2026-07-02): SUBSCRIPTION FIRST,
 * always. Precedence:
 *   1. the workspace's own connected subscription token (#246 unchanged — per-tenant billing wins),
 *   2. the deployment env's subscription token (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`,
 *      the owner's Fly secret) — the PRIMARY server credential; agents run on the owner's Claude
 *      subscription, not an API key,
 *   3. the deployment env's `ANTHROPIC_API_KEY` — OPTIONAL FALLBACK only,
 *   4. nothing (the gate posts a connect prompt instead of launching).
 * Every credential is env/vault-read only — never hardcoded, never persisted, and redacted from all
 * streamed output like every other injected secret.
 */
export function decideAgentAuth(input: AgentAuthInput): AgentAuth {
  const subscriptionToken = present(input.subscriptionToken);
  if (subscriptionToken) {
    // #659 validate-before-run-start: a stored token that is present but MALFORMED (an embedded
    // newline/space from a bad paste) fails LOUD and STOPS here — no fallback to the deployment's
    // credentials (Gemini HIGH on #1590). Falling through would silently bill the owner's account
    // for a tenant whose own connection is broken; instead the gate posts the plain-language
    // reconnect prompt up front. Format-only + pure (no network) — a well-formed-but-revoked token
    // is still caught at entry by the live checker and, failing that, by the existing
    // observed-failure → `expired` path.
    if (isWellFormedClaudeKey(subscriptionToken)) {
      return { mode: "subscription", secrets: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken } };
    }
    return { mode: "none", secrets: {}, reason: MALFORMED_WORKSPACE_TOKEN_REASON };
  }
  // Deployment-level credentials apply only when the workspace has NO token at all. A malformed
  // deployment token (bad Fly paste) cleanly falls back to the deployment's own API key — both are
  // the OWNER's credentials, so the posture's "never bill someone else's account" rule holds.
  const envSubscriptionToken = present(input.envSubscriptionToken);
  if (envSubscriptionToken && isWellFormedClaudeKey(envSubscriptionToken)) {
    return { mode: "subscription", secrets: { CLAUDE_CODE_OAUTH_TOKEN: envSubscriptionToken } };
  }
  const envApiKey = present(input.envApiKey);
  if (envApiKey) {
    return { mode: "api_key", secrets: { ANTHROPIC_API_KEY: envApiKey } };
  }
  return { mode: "none", secrets: {} };
}

/**
 * Whether a harness needs per-workspace Claude auth to do real work. The `demo` harness echoes the task
 * (no model spend) and needs nothing. `claude-code` requires the workspace owner's Claude token, so the
 * @mention path posts a friendly "connect your Claude account" prompt instead of launching a session
 * that can't run. `codex` is authenticated by the deployment-level Codex subscription bridge
 * (`CODEX_AUTH_JSON`) and is guarded by preflight instead of this per-tenant Claude gate.
 */
export function harnessRequiresAuth(kind: HarnessKind): boolean {
  return kind === "claude-code";
}

export interface AgentAuthResolverDeps {
  /** The workspace's subscription token from the per-tenant vault (null when not connected). */
  getSubscriptionToken(workspaceId: string): Promise<string | null>;
  /**
   * The deployment env's Claude subscription token (`CLAUDE_CODE_OAUTH_TOKEN`, #1568) — the PRIMARY
   * server credential. Read fresh per resolve so a rotated Fly secret takes effect without a
   * restart-ordering hazard. Optional: absent ⇒ #246 behavior.
   */
  getEnvSubscriptionToken?(): string | null;
  /** The deployment env's Anthropic API key (#1568) — optional FALLBACK only. Read fresh per resolve. */
  getEnvApiKey?(): string | null;
}

/**
 * Resolves the auth to use for a session, scoped to ONE workspace. The single source of truth for
 * both the secrets resolver (which injects the credential) and the @mention gate (which decides
 * whether to launch or post a connect prompt) — so they can never disagree. Per-tenant by
 * construction: `resolve` reads only the given workspace's token.
 */
export class AgentAuthResolver {
  constructor(private readonly deps: AgentAuthResolverDeps) {}

  async resolve(workspaceId: string): Promise<AgentAuth> {
    const subscriptionToken = await this.deps.getSubscriptionToken(workspaceId);
    return decideAgentAuth({
      subscriptionToken,
      envSubscriptionToken: this.deps.getEnvSubscriptionToken?.() ?? null,
      envApiKey: this.deps.getEnvApiKey?.() ?? null,
    });
  }
}

/** The credential env keys the auth layer OWNS (so they're never double-injected from elsewhere). */
export const AGENT_AUTH_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
