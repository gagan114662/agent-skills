/**
 * Production wiring for the connect-once service (#258 Stage 2, ADR-0258). Binds the pure service to real
 * seams:
 *
 *   - `caps` — the layered #58 config (`connectOnce` block → `resolveConnectOnceCaps`). Default OFF,
 *     owner-workspace-first.
 *   - `provider` — the CONSERVATIVE production default is the dry-run provider for EVERY connection: no live
 *     OAuth client is wired in this slice (premortem #200 §3 — nothing real is minted until a provider is
 *     genuinely live), so the flow stays an honest `coming_soon` even when enabled. A per-department
 *     follow-up (#265 Google, #268 ESP, #269 social, #272 ads) registers a real `OAuthConnectProvider` here.
 *   - `park` — parks a PENDING `connection.connect_account` #13 request (a CONSENT the owner gates; recorded
 *     -only on approval). There is no autonomous-connect path.
 */
import { createRequest } from "../db/repositories/approvals.js";
import { loadConfig } from "../config/loader.js";
import { CONNECTION_CONNECT_ACCOUNT_ACTION } from "../approvals/policy.js";
import { resolveConnectOnceCaps } from "./caps.js";
import { DryRunConnectProvider, type ConnectProvider } from "./provider.js";
import { ConnectOnceService, type ConnectOnceDeps } from "./service.js";

/**
 * The provider wired for a connection id. The production default is dry-run for every connector (no live
 * OAuth client is configured in this slice). A per-department follow-up replaces this with a registry that
 * returns a live `OAuthConnectProvider` for its connector and dry-run for the rest.
 */
export function defaultConnectProvider(_connectionId: string): ConnectProvider {
  return new DryRunConnectProvider();
}

/** Build the production-wired connect-once service. */
export function createDefaultConnectOnceService(): ConnectOnceService {
  const deps: ConnectOnceDeps = {
    caps: (workspaceId) => resolveConnectOnceCaps(loadConfig(workspaceId).connectOnce),
    provider: (connectionId) => defaultConnectProvider(connectionId),
    park: async (input) => {
      const req = await createRequest({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: CONNECTION_CONNECT_ACCOUNT_ACTION,
        payload: {
          connectionId: input.descriptor.id,
          provider: input.descriptor.provider,
          capabilities: input.descriptor.capabilities,
          oauthScopes: input.descriptor.oauthScopes,
        },
        amount: null,
        summary: `Connect ${input.descriptor.label} (${input.descriptor.provider})`.slice(0, 140),
        status: "pending", // CONSENT, owner-gated — parks in the decision queue (ADR-0258 Stage 2).
        expiresAt: null,
        events: [
          {
            type: "requested",
            detail: {
              source: "connect-once",
              connectionId: input.descriptor.id,
              provider: input.descriptor.provider,
            },
          },
        ],
      });
      return { id: req.id };
    },
  };
  return new ConnectOnceService(deps);
}
