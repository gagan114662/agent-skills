import { mintTrackingRef } from "./tracking.js";
import {
  attributeRevenue,
  rollupByArtifact,
  type ArtifactRevenue,
  type AttributedRevenueEvent,
  type AttributionReceipt,
  type Exposure,
} from "./chain.js";
import type { AttributionExposureStore } from "./store.js";

/**
 * The attributed-revenue ledger IO orchestrator (#386, ADR-0386). Pure orchestration over injected seams
 * (the #194 finance-service pattern): the exposure store, the verified-revenue reader, the chain-age cap,
 * and a clock — the pure causal-credit math lives in `chain.ts`. `default.ts` wires the real repos; unit
 * tests inject in-memory fakes (no DB).
 *
 * Two jobs:
 *  - {@link recordLiveShipExposure} mints the stable tracking ref for a fleet artifact that REALLY went
 *    live (the live URL / post id IS the artifact identity here) and records the exposure — the head of the
 *    chain. Idempotent on the ref, so a re-ship records ONE exposure.
 *  - {@link projectAttributedRevenue} joins exposures to verified Stripe receipts by tracking ref and
 *    projects credit by happened-before causality (L2). It adds NO money path — it only reads receipts that
 *    already exist (#98 webhook -> revenue_events).
 *
 * No clock of its own: the caller passes `now()` (epoch-ms) so the exposure timestamp is testable.
 */

/** Verified inbound revenue receipts for the projection — the finance RevenueEventReader seam (#194). */
export interface AttributionRevenueReceipt {
  /** Provider event id — the external receipt that makes this real (a Stripe event id). */
  providerEventId: string;
  amountCents: number;
  currency: string;
  createdAtMs: number;
  /**
   * The #386 tracking ref carried through Stripe checkout metadata onto the `revenue_events` row (slice 3).
   * Optional/null ⇒ the payment carried no ref ⇒ it stays `unattributed` (honest, never fabricated).
   */
  trackingRef?: string | null;
}

/** Lists verified inbound payment receipts for a workspace. Mirrors finance/service.ts RevenueEventReader. */
export interface AttributionRevenueReader {
  listReceipts(workspaceId: string, sinceMs?: number): Promise<AttributionRevenueReceipt[]>;
}

export interface AttributionServiceDeps {
  store: AttributionExposureStore;
  revenue: AttributionRevenueReader;
  /** The chain-age cap in ms (an exposure older than this before a payment is too stale to earn credit). */
  maxChainAgeMs: number;
  /** Clock seam (epoch ms). Pure core never calls Date.now — the caller injects the instant. */
  now: () => number;
}

export interface RecordLiveShipInput {
  workspaceId: string;
  /** The production-grounded external reference of the live ship: a live URL, a PR url, or a post id. */
  externalRef: string;
  /** The exposure channel (seo | social | email | ads | ...). */
  channel: string;
  /** The artifact kind (seo_page | social_post | email | ad | site_pr | ...). */
  artifactKind: string;
}

export interface AttributionProjection {
  attributed: AttributedRevenueEvent[];
  unattributed: AttributionReceipt[];
  byArtifact: ArtifactRevenue[];
}

/**
 * Record the exposure for a fleet artifact that REALLY went live. The live URL / post id IS the artifact
 * identity here, so the tracking ref is minted from `externalRef`. The exposure timestamp comes from the
 * injected clock (no Date.now in this layer). Idempotent on the ref — a re-ship records one exposure.
 * Returns the minted tracking ref so the caller can carry it forward (slice 3 stamps it into checkout).
 */
export async function recordLiveShipExposure(
  deps: AttributionServiceDeps,
  input: RecordLiveShipInput,
): Promise<string> {
  const trackingRef = mintTrackingRef({
    workspaceId: input.workspaceId,
    artifactId: input.externalRef,
    channel: input.channel,
  });
  await deps.store.recordExposure({
    workspaceId: input.workspaceId,
    artifactId: input.externalRef,
    artifactKind: input.artifactKind,
    trackingRef,
    channel: input.channel,
    occurredAtMs: deps.now(),
  });
  return trackingRef;
}

/**
 * Project attributed revenue for a workspace: load exposures + verified revenue receipts, credit each
 * receipt to the artifact whose exposure happened-before it under the same tracking ref, and roll up per
 * artifact. Adds NO money path — it only reads receipts that already exist.
 *
 * Slice 3 (#402) wired the ref through Stripe checkout metadata onto `revenue_events`, so a receipt now
 * carries the real `trackingRef`. A receipt whose ref matches a recorded exposure attributes by
 * happened-before; a receipt with NO ref (an existing row, or a no-ref payment) still lands in
 * `unattributed` — honest, never fabricated.
 */
export async function projectAttributedRevenue(
  deps: AttributionServiceDeps,
  workspaceId: string,
): Promise<AttributionProjection> {
  const exposures: Exposure[] = await deps.store.listExposures(workspaceId);
  const receiptRows = await deps.revenue.listReceipts(workspaceId);
  const receipts: AttributionReceipt[] = receiptRows.map((r) => ({
    providerEventId: r.providerEventId,
    // The real ref carried through Stripe checkout metadata (slice 3, #402); null ⇒ no ref ⇒ unattributed.
    trackingRef: r.trackingRef ?? null,
    amountCents: r.amountCents,
    currency: r.currency,
    // A receipt from the #98 webhook is a signature-verified provider event — verified by construction.
    verified: true,
    occurredAtMs: r.createdAtMs,
  }));
  const { attributed, unattributed } = attributeRevenue(exposures, receipts, {
    maxChainAgeMs: deps.maxChainAgeMs,
  });
  return { attributed, unattributed, byArtifact: rollupByArtifact(attributed) };
}
