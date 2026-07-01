import { OUTREACH_SEND_ACTION } from "../approvals/policy.js";
import { createRequest } from "../db/repositories/approvals.js";
import { dbMessageStore, dbReceiptStore } from "../db/repositories/outreach.js";
import { connectedAccountKinds } from "../realworld/default.js";
import { loadConfig } from "../config/loader.js";
import type { DiscoveryService } from "../discovery/service.js";
import type { DecisionMakerService } from "../decision-maker/service.js";
import type { PlanBillingService } from "../billing/plan-service.js";
import { buildPayLinkSpec, buildTrackedPayUrl } from "../leads/pay-link.js";
import { buildTrackedUrl } from "../attribution/tracking.js";
import { dbAttributionExposureStore } from "../db/repositories/attribution.js";
import { DEFAULT_PUBLIC_APP_ORIGIN } from "../product-origins.js";
import { resolveOutreachCaps } from "./caps.js";
import { OutreachService } from "./service.js";
import type { OutreachChannel } from "./types.js";

const DEFAULT_OUTREACH_TRIAL_BASE_URL = new URL("/start", DEFAULT_PUBLIC_APP_ORIGIN).toString();

/**
 * Production wiring for the outreach engine (#225, ADR-0225). Binds the service to the real seams:
 *
 *   - `prospects` — the #222 discovery queue (read-only).
 *   - `briefs` — the #223 buyer brief ledger (read-only, sanitized DATA — NOT a live profile reader, so
 *     the injection-quarantine wall holds end-to-end).
 *   - `pipeline` — a NARROW advancer that can ONLY record an externally-grounded #222 conversion.
 *   - `approvals` — parks a PENDING `outreach.send` #13 request (sensitive + irreversible by default); the
 *     send is recorded-only by the post-approval executor. No autonomous send path exists.
 *   - `connectedAccounts` — reuses the #231/#192 connected-account join so a send blocks (with what to
 *     connect) when the channel's account isn't wired.
 *
 * Default OFF: the caps resolve to `{enabled:false, sendProvider:"dryrun"}` until an owner opts in.
 */
export function createDefaultOutreachService(deps: {
  discovery: DiscoveryService;
  decisionMaker: DecisionMakerService;
  planService?: PlanBillingService;
}): OutreachService {
  const payLinks = deps.planService
    ? {
        mintForProspect: async (
          workspaceId: string,
          input: { leadOrArtifactId: string; channel: OutreachChannel; planId: string },
        ) => {
          const spec = buildPayLinkSpec(
            {
              workspaceId,
              leadOrArtifactId: input.leadOrArtifactId,
              channel: input.channel,
            },
            { planId: input.planId },
            "outreach",
          );
          const checkout = await deps.planService!.createCheckout({
            workspaceId,
            planKey: input.planId,
            trackingRef: spec.trackingRef,
          }).catch(() => null);
          await dbAttributionExposureStore
            .recordExposure({
              workspaceId,
              artifactId: input.leadOrArtifactId,
              artifactKind: "outreach_trial_link",
              trackingRef: spec.trackingRef,
              channel: input.channel,
              occurredAtMs: Date.now(),
            })
            .catch(() => undefined);
          return {
            url: checkout
              ? buildTrackedPayUrl(checkout.url, spec)
              : buildTrackedUrl(
                  DEFAULT_OUTREACH_TRIAL_BASE_URL + "?plan=" + encodeURIComponent(input.planId),
                  spec.trackingRef,
                  spec.utm,
                ),
          };
        },
      }
    : undefined;
  return new OutreachService({
    prospects: {
      queue: (workspaceId, opts) => deps.discovery.queue(workspaceId, opts),
    },
    briefs: {
      get: (workspaceId, id) => deps.decisionMaker.getBrief(workspaceId, id),
    },
    messages: dbMessageStore,
    receipts: dbReceiptStore,
    approvals: {
      submit: async (input) => {
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          actionType: input.actionType ?? OUTREACH_SEND_ACTION,
          payload: input.payload,
          amount: null,
          summary: input.summary,
          status: "pending", // outward irreversible surface — parks in the decision queue (ADR-0225).
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "outreach", ...input.payload } }],
        });
        return { id: req.id };
      },
    },
    ...(payLinks ? { payLinks } : {}),
    // The receipt advancer: record an externally-grounded #222 GTM stage (and nothing else).
    pipeline: {
      recordStage: async (workspaceId, input) => {
        if (input.stage === "conversion") {
          await deps.discovery.ingestSignal(workspaceId, {
            ideaId: input.ideaId,
            prospectKey: input.prospectKey,
            kind: "conversion",
            externalRef: input.externalRef,
            source: "outreach",
            detail: input.detail,
          });
          return;
        }
        await deps.discovery.advancePipelineStage(workspaceId, {
          ideaId: input.ideaId,
          prospectKey: input.prospectKey,
          stage: input.stage,
          externalRef: input.externalRef,
        });
      },
    },
    connectedAccounts: (workspaceId) => connectedAccountKinds(workspaceId),
    caps: (workspaceId) => resolveOutreachCaps(loadConfig(workspaceId).outreach),
  });
}
