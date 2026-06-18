/**
 * Production wiring for the Ads service (#272, ADR-0272). Binds the pure {@link AdsService} to real seams:
 *
 *   - `caps` — the layered #58 config (`ads` block → `resolveAdsCaps`). Default OFF, owner-workspace-first,
 *     hard per-action cap 0 until the owner sets it.
 *   - `connectedConnectionIds` — the #192 vault: which connectors the workspace has actually connected (so
 *     Bid's `ads` capability gate is honest).
 *   - `readAccount` — the CONSERVATIVE production default is the {@link DryRunAdsProvider}: it reads back
 *     NOTHING (premortem #200 §3 — never assume; an unwired deployment is honestly "not connected"). A live
 *     ads-API provider behind the connect-once OAuth seam is the deliberate follow-up.
 *   - `park` — parks a PENDING money-gated `provisioning.customer_spend` #13 request (recorded-only on
 *     approval; no money moves). There is no autonomous-spend path.
 */
import { createRequest } from "../db/repositories/approvals.js";
import { listServiceStatuses } from "../db/repositories/external-credentials.js";
import { loadConfig } from "../config/loader.js";
import { resolveAdsCaps } from "./caps.js";
import { DryRunAdsProvider, type AdsProvider } from "./provider.js";
import { AdsService, type AdsServiceDeps } from "./service.js";

/** Build the production-wired ads service. */
export function createDefaultAdsService(): AdsService {
  const provider: AdsProvider = new DryRunAdsProvider();
  const deps: AdsServiceDeps = {
    caps: (workspaceId) => resolveAdsCaps(loadConfig(workspaceId).ads),
    connectedConnectionIds: async (workspaceId) => {
      const rows = await listServiceStatuses(workspaceId);
      return new Set(rows.filter((r) => r.connected).map((r) => r.serviceKey));
    },
    // Dry-run by default: no live ads-API client is wired in this slice, so we read back nothing real.
    readAccount: (workspaceId) => provider.getAccountState({ workspaceId, accountRef: "" }),
    park: async (input) => {
      const req = await createRequest({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: input.actionType,
        payload: {
          capabilityId: input.capabilityId,
          amountCents: input.amountCents,
          campaignRef: input.campaignRef,
          summary: input.summary,
        },
        // The exact amount the owner is approving — shown on the #13 card, re-gated by the spend cap.
        amount: input.amountCents,
        summary: input.summary.slice(0, 140),
        status: "pending", // MONEY, owner-gated — parks in the decision queue (ADR-0272/#243).
        expiresAt: null,
        events: [
          {
            type: "requested",
            detail: { source: "ads", capabilityId: input.capabilityId, amountCents: input.amountCents },
          },
        ],
      });
      return { id: req.id };
    },
  };
  return new AdsService(deps);
}
