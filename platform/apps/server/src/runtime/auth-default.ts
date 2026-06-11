import { AgentAuthResolver } from "./agent-auth.js";
import { getWorkspaceClaudeToken } from "../db/repositories/agent-credentials.js";

/**
 * Production wiring for subscription-first agent auth (#68, ADR-0068). The SINGLE source of truth
 * shared by the SessionManager's secrets resolver (which injects the credential) and the @mention
 * gate (which decides launch vs. connect-prompt) — so they can never disagree.
 *
 * Per-tenant by construction: `getSubscriptionToken` reads exactly one workspace's vault row. The
 * platform key is the operator's org-wide fallback (`ANTHROPIC_API_KEY`), used only when a tenant has
 * connected nothing — never a pooled user subscription.
 */
export function createAgentAuthResolver(env: NodeJS.ProcessEnv = process.env): AgentAuthResolver {
  return new AgentAuthResolver({
    getSubscriptionToken: (workspaceId) => getWorkspaceClaudeToken(workspaceId),
    platformKey: () => {
      const key = env.ANTHROPIC_API_KEY;
      return key && key.trim().length > 0 ? key : null;
    },
  });
}
