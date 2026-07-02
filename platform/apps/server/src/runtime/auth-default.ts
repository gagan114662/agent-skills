import { AgentAuthResolver } from "./agent-auth.js";
import { getWorkspaceClaudeToken } from "../db/repositories/agent-credentials.js";

/**
 * Production wiring for agent auth (#68, ADR-0068; #246; #1568). The SINGLE source of truth shared
 * by the SessionManager's secrets resolver (which injects the credential) and the @mention gate
 * (which decides launch vs. reconnect-prompt) — so they can never disagree.
 *
 * Per-tenant by construction: `getSubscriptionToken` reads exactly one workspace's vault row and
 * always wins. #1568 (owner decision 2026-07-02, supersedes the #246 no-key rule) adds the
 * deployment-env `ANTHROPIC_API_KEY` as the FALLBACK credential so the Claude runtime can execute
 * without a per-workspace subscription connect — the key is the owner's own Fly secret, env-only,
 * never persisted or logged.
 */
export function createAgentAuthResolver(): AgentAuthResolver {
  return new AgentAuthResolver({
    getSubscriptionToken: (workspaceId) => getWorkspaceClaudeToken(workspaceId),
    getEnvApiKey: () => process.env.ANTHROPIC_API_KEY ?? null,
  });
}
