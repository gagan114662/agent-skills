import { AgentAuthResolver } from "./agent-auth.js";
import { getWorkspaceClaudeToken } from "../db/repositories/agent-credentials.js";

/**
 * Production wiring for subscription-ONLY agent auth (#68, ADR-0068; tightened in #246). The SINGLE
 * source of truth shared by the SessionManager's secrets resolver (which injects the credential) and
 * the @mention gate (which decides launch vs. reconnect-prompt) — so they can never disagree.
 *
 * Per-tenant by construction: `getSubscriptionToken` reads exactly one workspace's vault row. #246
 * removed the operator `ANTHROPIC_API_KEY` fallback entirely — an agent run uses the connected
 * subscription token or it doesn't run, so an API key can never ship from this path.
 */
export function createAgentAuthResolver(): AgentAuthResolver {
  return new AgentAuthResolver({
    getSubscriptionToken: (workspaceId) => getWorkspaceClaudeToken(workspaceId),
  });
}
