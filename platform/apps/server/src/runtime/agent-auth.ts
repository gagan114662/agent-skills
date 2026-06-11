import type { HarnessKind } from "./harness.js";

/**
 * Subscription-first agent auth (#68, ADR-0068).
 *
 * A real fleet agent must run on the *owner's own* Claude subscription, never a pooled platform key.
 * This module is the pure decision at the center of that promise: given a single workspace's
 * subscription token and the (optional) operator-wide platform key, it picks the auth to inject into
 * a session — subscription first, platform only as a fallback, else nothing.
 *
 * **Compliance invariant — one subscription is never pooled across workspaces.** This function only
 * ever receives ONE workspace's token (resolved per `workspaceId` upstream), so it is structurally
 * incapable of crossing tenants. The platform key is the operator's org key (a single shared
 * fallback for tenants who connected nothing), NOT a user subscription — so using it is not pooling.
 */
export type AgentAuth =
  | { mode: "subscription"; secrets: { CLAUDE_CODE_OAUTH_TOKEN: string } }
  | { mode: "platform"; secrets: { ANTHROPIC_API_KEY: string } }
  | { mode: "none"; secrets: Record<string, never> };

export interface AgentAuthInput {
  /** The workspace's own Claude subscription token (`claude setup-token`), or null if not connected. */
  subscriptionToken: string | null;
  /** The operator-wide platform API key fallback, or null if the operator configured none. */
  platformKey: string | null;
}

/** A non-empty, non-whitespace string, else null — a blank stored secret must not count as auth. */
function present(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decide the auth to inject for a session. Order: workspace subscription token → platform key →
 * none. The chosen secret is the ONLY model credential returned (the subscription token never ships
 * alongside the platform key).
 */
export function decideAgentAuth(input: AgentAuthInput): AgentAuth {
  const subscriptionToken = present(input.subscriptionToken);
  if (subscriptionToken) {
    return { mode: "subscription", secrets: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken } };
  }
  const platformKey = present(input.platformKey);
  if (platformKey) {
    return { mode: "platform", secrets: { ANTHROPIC_API_KEY: platformKey } };
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
  /** The operator-wide platform key fallback, read lazily (null when none configured). */
  platformKey(): string | null;
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
    return decideAgentAuth({ subscriptionToken, platformKey: this.deps.platformKey() });
  }
}

/** The credential env keys the auth layer OWNS (so they're never double-injected from elsewhere). */
export const AGENT_AUTH_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
