/**
 * The Ads SERVICE (#272, ADR-0272) — the IO orchestrator behind Bid's ad surface. It owns NO new authority:
 * the pure cores decide everything (`caps` for scope, `decideAdsSpend` for the money gate, `decideCreativeReview`
 * for honest status), and a real spend is parked as a #13 money-gated `provisioning.customer_spend` request the
 * owner approves. There is NO autonomous-spend path.
 *
 *   - `status` reports HONEST connected / account / creative-review state, read back from the provider (never
 *     assumed; #200 §3) and quarantined (#200 §6). Not connected ⇒ honest "not connected", null account.
 *   - `requestSpend` routes a proposed spend through `decideAdsSpend`. A valid spend within the hard per-action
 *     cap parks an owner approval with the EXACT amount; anything else (off / over cap / unconnected / invalid)
 *     is refused and parks NOTHING.
 *
 * Every side effect is one injected seam, so the service runs against fakes in unit tests and real repos in
 * `default.ts` (mirrors `connections/service.ts`, `provisioning/service.ts`).
 */
import type { Identity } from "../auth/identity.js";
import { CONNECTION_DESCRIPTORS } from "../connections/registry.js";
import { hasConnectedCapability } from "../connections/capabilities.js";
import { PROVISIONING_CUSTOMER_SPEND_ACTION } from "../approvals/policy.js";
import type { AdsCaps } from "./caps.js";
import { isAdsEnabledForWorkspace, adsPerActionCapCents } from "./caps.js";
import { decideAdsSpend, type AdsSpendRequest } from "./spend.js";
import {
  ADS_CAPABILITY,
  sanitizeAccountSnapshot,
  type AdsAccountSnapshot,
  type SafeAdsAccount,
} from "./provider.js";
import {
  decideCreativeReview,
  summarizeCreativeReviews,
  type CreativeReviewDecision,
  type CreativeReviewSummary,
} from "./creative-review.js";

/** The structural provider id for the ads connector (set by the routing decision, never read from a body). */
const ADS_PROVIDER_ID = "google_ads";

export interface AdsServiceDeps {
  /** Resolve the per-workspace ads caps (the spend flag + owner-first + hard cap). */
  caps(workspaceId: string): AdsCaps;
  /** Which connection ids the workspace has connected (#192 vault) — used to gate the `ads` capability. */
  connectedConnectionIds(workspaceId: string): Promise<ReadonlySet<string>>;
  /** Read back the account's campaign + spend state from the provider (null ⇒ nothing real to read). */
  readAccount(workspaceId: string): Promise<AdsAccountSnapshot | null>;
  /** Park a PENDING `provisioning.customer_spend` #13 request; returns its id. */
  park(input: {
    workspaceId: string;
    requesterMemberId: string;
    actionType: typeof PROVISIONING_CUSTOMER_SPEND_ACTION;
    amountCents: number;
    capabilityId: string;
    campaignRef: string | null;
    summary: string;
  }): Promise<{ id: string }>;
}

export interface AdsStatus {
  /** Is an ad account connected (the `ads` capability unlocked)? */
  connected: boolean;
  /** Is the money-gated spend path offered for this workspace? */
  enabled: boolean;
  /** The hard per-action cap in cents the system never crosses (0 ⇒ no spend approvable). */
  perActionCapCents: number;
  /** The read-back, sanitized account state — or null when not connected / no live data (honest). */
  account: SafeAdsAccount | null;
  /** Per-creative honest review status. */
  creativeReviews: CreativeReviewDecision[];
  /** Aggregate honest review summary. */
  reviewSummary: CreativeReviewSummary;
}

export type RequestSpendResult =
  | { status: "pending_approval"; requestId: string; amountCents: number; capCents: number; summary: string }
  | { status: "no_spend"; reason: string }
  | { status: "blocked"; reason: string };

export class AdsService {
  constructor(private readonly deps: AdsServiceDeps) {}

  async status(workspaceId: string): Promise<AdsStatus> {
    const caps = this.deps.caps(workspaceId);
    const connectedIds = await this.deps.connectedConnectionIds(workspaceId);
    const connected = hasConnectedCapability({
      descriptors: CONNECTION_DESCRIPTORS,
      connectedIds,
      capability: ADS_CAPABILITY,
    });
    const enabled = isAdsEnabledForWorkspace(caps, workspaceId);
    const perActionCapCents = adsPerActionCapCents(caps);

    let account: SafeAdsAccount | null = null;
    let creativeReviews: CreativeReviewDecision[] = [];
    if (connected) {
      const snapshot = await this.deps.readAccount(workspaceId);
      if (snapshot) {
        account = sanitizeAccountSnapshot(ADS_PROVIDER_ID, snapshot).data;
        creativeReviews = account.campaigns.flatMap((c) =>
          c.creatives.map((cr) =>
            decideCreativeReview({
              creativeRef: cr.creativeRef,
              state: cr.reviewState,
              reason: cr.reviewReason,
              ageHours: cr.ageHours,
            }),
          ),
        );
      }
    }
    return {
      connected,
      enabled,
      perActionCapCents,
      account,
      creativeReviews,
      reviewSummary: summarizeCreativeReviews(creativeReviews),
    };
  }

  /**
   * Route a proposed ad spend through the money gate. Requires a connected ad account first, then defers to
   * `decideAdsSpend` (flag + hard cap). A valid spend parks an owner approval with the EXACT amount; anything
   * refused parks NOTHING — there is no autonomous-spend path.
   */
  async requestSpend(identity: Identity, request: AdsSpendRequest): Promise<RequestSpendResult> {
    const connectedIds = await this.deps.connectedConnectionIds(identity.workspaceId);
    const connected = hasConnectedCapability({
      descriptors: CONNECTION_DESCRIPTORS,
      connectedIds,
      capability: ADS_CAPABILITY,
    });
    if (!connected) {
      return { status: "blocked", reason: "connect a Google Ads account before releasing any spend" };
    }
    const caps = this.deps.caps(identity.workspaceId);
    const decision = decideAdsSpend(request, {
      enabledForWorkspace: isAdsEnabledForWorkspace(caps, identity.workspaceId),
      perActionCapCents: adsPerActionCapCents(caps),
    });
    if (decision.status !== "needs_approval") return decision;

    const req = await this.deps.park({
      workspaceId: identity.workspaceId,
      requesterMemberId: identity.memberId,
      actionType: decision.actionType,
      amountCents: decision.amountCents,
      capabilityId: "ads_spend",
      campaignRef: decision.campaignRef,
      summary: decision.summary,
    });
    return {
      status: "pending_approval",
      requestId: req.id,
      amountCents: decision.amountCents,
      capCents: decision.capCents,
      summary: decision.summary,
    };
  }
}
