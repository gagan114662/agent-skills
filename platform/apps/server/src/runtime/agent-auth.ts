import type { HarnessKind } from "./harness.js";

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
  | { mode: "none"; secrets: Record<string, never> };

export interface AgentAuthInput {
  /** The workspace's own Claude subscription token (`claude setup-token`), or null if not connected. */
  subscriptionToken: string | null;
}

/** A non-empty, non-whitespace string, else null — a blank stored secret must not count as auth. */
function present(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decide the auth to inject for a session (#246): the workspace subscription token, else NOTHING.
 * There is deliberately no API-key fallback — the subscription token is the only model credential an
 * agent run can ever carry, so an API key can never ship from this path.
 */
export function decideAgentAuth(input: AgentAuthInput): AgentAuth {
  const subscriptionToken = present(input.subscriptionToken);
  if (subscriptionToken) {
    return { mode: "subscription", secrets: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken } };
  }
  return { mode: "none", secrets: {} };
}

/**
 * Whether a harness needs model auth to do real work. The `demo` harness echoes the task (no model
 * spend) and needs nothing; the real coding harnesses require a credential — so the @mention path
 * posts a friendly "connect your Claude account" prompt instead of launching a session that can't run.
 */
export function harnessRequiresAuth(kind: HarnessKind): boolean {
  return kind !== "demo";
}

export interface AgentAuthResolverDeps {
  /** The workspace's subscription token from the per-tenant vault (null when not connected). */
  getSubscriptionToken(workspaceId: string): Promise<string | null>;
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
    return decideAgentAuth({ subscriptionToken });
  }
}

/** The credential env keys the auth layer OWNS (so they're never double-injected from elsewhere). */
export const AGENT_AUTH_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
