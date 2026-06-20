/**
 * Trackable pay-link service seam (Leads Centre GAP 3, ADR-0401) — the IO orchestrator over the pure
 * {@link ./pay-link} core. Given a (workspace, plan, lead/artifact, channel) it:
 *
 *   1. resolves the plan/price (the catalog price the link collects against),
 *   2. mints a Stripe payment LINK via the existing #98 billing seam WITH `{ trackingRef }` metadata,
 *   3. records an attribution EXPOSURE (the pay link shown to a lead IS an exposure), and
 *   4. returns the tracked URL (ref + UTM in the query string).
 *
 * SAFETY (#98 inbound-only + #200): minting a collection link is NOT money-out — no charge/payout/refund
 * path exists here, by construction (the billing seam is inbound-only). The link is an inert draft URL until
 * a human clicks + pays through the #98-owned Stripe rails (#13-gated money-out). This service NEVER sends
 * outreach; it only composes a payable link into the body the (gated) outreach path already produces.
 *
 * The billing + attribution seams are injected, so unit tests run on fakes with no DB and no Stripe. With the
 * default `none` billing provider (BILLING_PROVIDER unset) the hosted link is a deterministic non-live
 * placeholder (`https://pay.none.reload.test/...`); going LIVE needs `BILLING_PROVIDER=stripe` (set in prod).
 */

import type { CreatePaymentLinkInput, PaymentLinkResult } from "../billing/provider.js";
import type { RecordExposureInput } from "../attribution/store.js";
import { buildPayLinkSpec, buildTrackedPayUrl } from "./pay-link.js";

/**
 * The narrow inbound-only billing seam this service needs — a subset of {@link
 * ../billing/provider.BillingProvider}. By design it can ONLY create a collection link; there is no
 * charge/payout/refund method to call, so this service cannot move money out.
 */
export interface PayLinkBilling {
  readonly kind: string;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult>;
}

/**
 * The narrow attribution-exposure seam — a subset of {@link ../attribution/store.AttributionExposureStore}.
 * Recording the exposure is idempotent on (workspaceId, trackingRef), so re-minting a link for the same lead
 * records ONE exposure row.
 */
export interface PayLinkExposureRecorder {
  recordExposure(input: RecordExposureInput): Promise<{ id: string }>;
}

/** Resolve the catalog price + per-tenant secrets the link collects against (kept off the pure core). */
export interface PayLinkPlanResolver {
  /**
   * Resolve a plan id to its provider price id + the slug/secrets the billing seam needs, or `null` for an
   * unknown plan. Mirrors the #125 `ensurePrice` find-or-create the route already performs.
   */
  resolve(
    workspaceId: string,
    planId: string,
  ): Promise<{ priceId: string; slug: string; secrets: Record<string, string> } | null>;
}

export interface MintTrackablePayLinkDeps {
  billing: PayLinkBilling;
  exposures: PayLinkExposureRecorder;
  plans: PayLinkPlanResolver;
  /** The attribution `defaultUtmSource` (e.g. "ipop") — stamped as the link's UTM source. */
  utmSource: string;
  /** Clock seam (epoch ms). The pure core has no clock; the exposure timestamp comes from here. */
  now: () => number;
}

export interface MintTrackablePayLinkInput {
  workspaceId: string;
  planId: string;
  /** The lead / outreach-artifact the payment is attributed back to (a lead id, message id, or prospect key). */
  leadOrArtifactId: string;
  /** The outreach channel the link ships through (e.g. "email", "linkedin", "x"). */
  channel: string;
}

export interface TrackablePayLink {
  /** The tracked hosted URL (ref + UTM in the query string) to drop into the outreach body. */
  url: string;
  /** The #386 tracking ref carried by the URL AND the link metadata (so GAP 2 can recover it). */
  trackingRef: string;
  /** The billing provider that minted the link (`none` ⇒ non-live placeholder; `stripe` ⇒ real). */
  provider: string;
}

/**
 * Mint a trackable, payable link for a lead/artifact and record its exposure. Returns the {@link
 * TrackablePayLink} on success, or `null` when the plan is unknown — the caller treats a `null` as "no pay
 * link available" and composes the body unchanged. Adds NO money-out path.
 *
 * Note: with the `none` provider the returned URL is a deterministic non-live placeholder; the exposure is
 * still recorded so the chain is exercised end-to-end in dev/CI. Real collection needs BILLING_PROVIDER=stripe.
 */
export async function mintTrackablePayLink(
  deps: MintTrackablePayLinkDeps,
  input: MintTrackablePayLinkInput,
): Promise<TrackablePayLink | null> {
  const resolved = await deps.plans.resolve(input.workspaceId, input.planId);
  if (!resolved) return null;

  const spec = buildPayLinkSpec(
    {
      workspaceId: input.workspaceId,
      leadOrArtifactId: input.leadOrArtifactId,
      channel: input.channel,
    },
    { planId: input.planId },
    deps.utmSource,
  );

  // Mint the inbound-only collection link WITH the trackingRef metadata (round-tripped on the #98 webhook).
  const link = await deps.billing.createPaymentLink({
    priceId: resolved.priceId,
    slug: resolved.slug,
    metadata: spec.metadata,
    secrets: resolved.secrets,
  });

  // The pay link shown to a lead is an EXPOSURE — record it (idempotent on the ref) so a later payment joins.
  await deps.exposures.recordExposure({
    workspaceId: input.workspaceId,
    artifactId: input.leadOrArtifactId,
    artifactKind: "pay_link",
    trackingRef: spec.trackingRef,
    channel: input.channel,
    occurredAtMs: deps.now(),
  });

  return {
    url: buildTrackedPayUrl(link.url, spec),
    trackingRef: spec.trackingRef,
    provider: deps.billing.kind,
  };
}
