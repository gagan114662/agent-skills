/**
 * #266 — production wiring for hosted publishing. Composes the {@link HostedPublishService} over the real
 * repos (`db/repositories/hosted.ts`), the #13 approvals queue (the gate ALWAYS parks a PENDING request —
 * the hard constraint), and the per-workspace `hostedSites` config (default-OFF, owner-workspace-first).
 */

import { createRequest } from "../db/repositories/approvals.js";
import { dbHostedSiteStore, dbHostedPageStore, dbHostedViewStore } from "../db/repositories/hosted.js";
import { loadConfig } from "../config/loader.js";
import { HOSTED_PUBLISH_ACTION } from "../approvals/policy.js";
import { resolveHostedSitesFlags, type HostedSitesFlags } from "./decide.js";
import { createHostedPublishDispatcher, type HostedPublishDispatcher } from "./dispatcher.js";
import { HostedPublishService, type HostedApprovalGate } from "./service.js";

/** Resolve the hosted-publishing flags for a workspace from its config (default-OFF, owner-first). */
export function hostedFlagsFor(workspaceId: string): HostedSitesFlags {
  return resolveHostedSitesFlags(loadConfig(workspaceId).hostedSites, workspaceId);
}

/** Resolve the ipop subdomain base host from config (falls back to the module default). */
function hostedBaseHost(workspaceId: string): string | undefined {
  return loadConfig(workspaceId).hostedSites.baseHost;
}

/**
 * The #13 gate: ALWAYS parks a PENDING `hosted.publish` request the owner must approve before the page goes
 * live (ADR-0266 — no autonomous publish path). Mirrors the realworld/outreach park-PENDING pattern.
 */
const hostedApprovalGate: HostedApprovalGate = {
  async submit(input) {
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: HOSTED_PUBLISH_ACTION,
      payload: input.payload,
      amount: null,
      summary: input.summary,
      status: "pending", // outward public surface — parks in the decision queue (ADR-0266)
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "hosted", ...input.payload } }],
    });
    return { id: req.id };
  },
};

/** Build the production hosted-publishing service over the real repos + the #13 gate. */
export function buildHostedPublishService(workspaceId?: string): HostedPublishService {
  return new HostedPublishService({
    sites: dbHostedSiteStore,
    pages: dbHostedPageStore,
    views: dbHostedViewStore,
    approvals: hostedApprovalGate,
    flags: hostedFlagsFor,
    baseHost: workspaceId ? hostedBaseHost(workspaceId) : undefined,
  });
}

/** Build the production publish dispatcher (the post-approval ship path for the #13 executor). */
export function buildHostedPublishDispatcher(): HostedPublishDispatcher {
  return createHostedPublishDispatcher({
    service: buildHostedPublishService(),
    flags: hostedFlagsFor,
  });
}
