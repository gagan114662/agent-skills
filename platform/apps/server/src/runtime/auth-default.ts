import { AgentAuthResolver } from "./agent-auth.js";
import { getWorkspaceClaudeToken } from "../db/repositories/agent-credentials.js";

/**
 * Production wiring for agent auth (#68, ADR-0068; #246; #1568). The SINGLE source of truth shared
 * by the SessionManager's secrets resolver (which injects the credential) and the @mention gate
 * (which decides launch vs. reconnect-prompt) — so they can never disagree.
 *
 * Per-tenant by construction: `getSubscriptionToken` reads exactly one workspace's vault row and
 * always wins. #1568 (owner decision 2026-07-02): agents run on the owner's Claude SUBSCRIPTION —
 * the deployment env's `CLAUDE_CODE_OAUTH_TOKEN` (headless `claude setup-token` output, a Fly
 * secret) is the PRIMARY server credential; `ANTHROPIC_API_KEY` is an optional FALLBACK only. Both
 * are env-only, never persisted or logged.
 */
export function createAgentAuthResolver(): AgentAuthResolver {
  return new AgentAuthResolver({
    getSubscriptionToken: (workspaceId) => getWorkspaceClaudeToken(workspaceId),
    getEnvSubscriptionToken: () => process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    getEnvApiKey: () => process.env.ANTHROPIC_API_KEY ?? null,
  });
}
