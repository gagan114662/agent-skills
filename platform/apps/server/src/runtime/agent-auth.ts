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
  | { mode: "none"; secrets: Record<string, never> };

export interface AgentAuthInput {
  /** The workspace's own Claude subscription token (`claude setup-token`), or null if not connected. */
  subscriptionToken: string | null;
  /**
   * The deployment's Anthropic API key (#1568, owner decision 2026-07-02): read from the server env
   * (`ANTHROPIC_API_KEY` set by the owner in Fly), NEVER stored in code or the DB. Fallback only — a
   * workspace's own connected subscription token still wins, so per-tenant billing is unchanged when
   * connected. Optional so every existing caller keeps the #246 subscription-or-nothing behavior.
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
 * Decide the auth to inject for a session: the workspace subscription token first (#246 unchanged),
 * else the deployment's env `ANTHROPIC_API_KEY` (#1568), else NOTHING. The owner decision of
 * 2026-07-02 reintroduced a DEPLOYMENT-level API-key path so the Claude runtime can run without a
 * per-workspace subscription connect: the key is the owner's own Fly secret, read from env only —
 * never hardcoded, never persisted, and still redacted from all streamed output like every other
 * injected secret. A workspace's connected subscription always wins, so connected tenants keep
 * billing their own subscription exactly as before.
 */
export function decideAgentAuth(input: AgentAuthInput): AgentAuth {
  const subscriptionToken = present(input.subscriptionToken);
  // #659 validate-before-run-start: a stored token that is present but MALFORMED (an embedded
  // newline/space from a bad paste) is treated as absent, so the @mention auth gate posts the
  // "reconnect your Claude" prompt up front instead of injecting a doomed credential that crashes the
  // session mid-run. Format-only + pure (no network) — a well-formed-but-revoked token is still caught
  // at entry by the live checker and, failing that, by the existing observed-failure → `expired` path.
  if (subscriptionToken && isWellFormedClaudeKey(subscriptionToken)) {
    return { mode: "subscription", secrets: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken } };
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
   * The deployment env's Anthropic API key (#1568), or null. Read fresh per resolve so a rotated
   * Fly secret takes effect without a restart-ordering hazard. Optional: absent ⇒ #246 behavior.
   */
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
    return decideAgentAuth({ subscriptionToken, envApiKey: this.deps.getEnvApiKey?.() ?? null });
  }
}

/** The credential env keys the auth layer OWNS (so they're never double-injected from elsewhere). */
export const AGENT_AUTH_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
