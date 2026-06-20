/**
 * Trackable pay-link composition — pure core (Leads Centre GAP 3, ADR-0401).
 *
 * The fleet's outreach finally gets a TRACKABLE WAY TO PAY: a Stripe payment LINK (inbound collection, never
 * a charge) that carries a #386 tracking ref so a reached human can click, pay, and have that payment
 * attributed back to the exact outreach that earned it. This module is the PURE half — it computes the
 * tracking ref, the link metadata payload, and the UTM-stamped final URL. It NEVER touches Stripe, the
 * clock, or any IO: the ref is a deterministic function of (workspace, lead/artifact, channel), exactly like
 * the badge ({@link ../attribution/badge}) and the exposure ledger ({@link ../attribution/service}).
 *
 * SAFETY (#98 inbound-only + #200): minting a collection link is NOT money-out. A charge/payout/refund is
 * the money-out action and stays #13-gated. The link here only ever COLLECTS — it is an inert draft URL
 * until a human clicks it and pays through the #98-owned Stripe rails.
 *
 * The ref rides TWICE so GAP 2 (the #98 webhook → revenue_events) can recover it:
 *   1. in the URL (UTM + `?ref=` via {@link ../attribution/tracking.buildTrackedUrl}), recovered on landing;
 *   2. in the payment-link METADATA (`{ trackingRef }`), round-tripped on the Stripe webhook.
 */

import { mintTrackingRef, buildTrackedUrl, type Utm } from "../attribution/tracking.js";

/** The UTM medium stamped on every outreach pay link — distinguishes it from a badge/seo exposure. */
export const PAY_LINK_UTM_MEDIUM = "outreach";

export interface PayLinkRefInput {
  workspaceId: string;
  /**
   * The lead / outreach-artifact id a future payment is attributed back to (a lead id, a message id, or a
   * prospect key). This IS the artifact identity in the attribution chain, so the same lead always carries
   * the same ref — re-minting is idempotent.
   */
  leadOrArtifactId: string;
  /** The outreach channel the link ships through (e.g. "email", "linkedin", "x"). */
  channel: string;
}

export interface PayLinkPlan {
  /** The plan/price the link targets (e.g. a {@link ../billing/plans.PlanKey}). Used for the UTM campaign. */
  planId: string;
}

/** Everything the pure layer can compute for a trackable pay link, before any Stripe call. */
export interface PayLinkSpec {
  /** The #386 tracking ref — minted deterministically from (workspace, lead/artifact, channel). */
  trackingRef: string;
  /** Metadata to attach when minting the Stripe link so the #98 webhook can recover the ref (GAP 2). */
  metadata: { trackingRef: string };
  /** The UTM provenance stamped onto the hosted URL (source = caller's attribution `defaultUtmSource`). */
  utm: Utm;
}

/**
 * Compute the tracking ref, the link metadata, and the UTM provenance for a trackable pay link. Pure: no IO,
 * no clock. The ref is minted from (workspace, lead/artifact, channel) so it is stable + re-derivable, and it
 * is placed in BOTH the metadata (round-tripped on the webhook) and — once a hosted URL exists — the URL
 * (recovered on landing). Does NOT call Stripe.
 */
export function buildPayLinkSpec(
  ref: PayLinkRefInput,
  plan: PayLinkPlan,
  utmSource: string,
): PayLinkSpec {
  const trackingRef = mintTrackingRef({
    workspaceId: ref.workspaceId,
    artifactId: ref.leadOrArtifactId,
    channel: ref.channel,
  });
  return {
    trackingRef,
    metadata: { trackingRef },
    utm: {
      source: utmSource,
      medium: PAY_LINK_UTM_MEDIUM,
      campaign: plan.planId,
    },
  };
}

/**
 * Wrap a raw hosted payment-link URL (from {@link ../billing/provider.BillingProvider.createPaymentLink}) so
 * the tracking ref + UTM ride along in the query string. Delegates to {@link
 * ../attribution/tracking.buildTrackedUrl}, which preserves any existing query/hash and returns the input
 * unchanged if it is not a parseable absolute URL — we never corrupt the link.
 */
export function buildTrackedPayUrl(hostedUrl: string, spec: PayLinkSpec): string {
  return buildTrackedUrl(hostedUrl, spec.trackingRef, spec.utm);
}
