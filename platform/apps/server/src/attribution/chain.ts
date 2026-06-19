import { externalDemandEvidence, type ExternalDemandEvidence } from "../demand/provenance.js";

/**
 * The causal chain + credit-by-causality projection for the attributed-revenue ledger (#386, ADR-0386).
 *
 * `fleet artifact → exposure → signup → payment`. Credit flows by **happened-before** (L2): a payment is
 * credited to the artifact whose exposure preceded it under the same tracking ref. Every credited dollar
 * is backed by an **external receipt** (L1): an unverified receipt earns no credit. Artifacts are ranked
 * by **revenue-weighted outcome** (L3): fund what produced receipted dollars, not impressions.
 *
 * Pure: no IO, no clock. This module adds NO money path — it only projects credit over receipts that
 * already exist (the #98 Stripe webhook → `revenue_events`). A receipt with no ref, no matching exposure,
 * or an exposure that did not precede it is returned UNATTRIBUTED, never fabricated onto an artifact.
 */

/** An exposure: a fleet artifact shown to the world under a tracking ref (the head of the chain). */
export interface Exposure {
  artifactId: string;
  artifactKind: string;
  trackingRef: string;
  channel: string;
  occurredAtMs: number;
}

/** A verified external receipt (a Stripe payment). The apex of the chain; the ONLY source of a number (L1). */
export interface AttributionReceipt {
  /** Provider event id — the external receipt that makes this real (a Stripe event id). */
  providerEventId: string;
  /** The tracking ref carried through checkout metadata (null ⇒ unattributable to an artifact). */
  trackingRef: string | null;
  amountCents: number;
  currency: string;
  /** True iff this came from a signature-verified provider webhook. A non-verified receipt earns no credit. */
  verified: boolean;
  occurredAtMs: number;
}

/** A receipt credited to the artifact that caused it, by happened-before causality (L2). */
export interface AttributedRevenueEvent {
  providerEventId: string;
  artifactId: string;
  artifactKind: string;
  channel: string;
  trackingRef: string;
  amountCents: number;
  currency: string;
  exposureAtMs: number;
  paidAtMs: number;
}

export interface AttributeRevenueResult {
  /** Receipts credited to an originating artifact (verified + a happened-before exposure on the same ref). */
  attributed: AttributedRevenueEvent[];
  /** Verified-but-uncredited and unverified receipts (no ref, no exposure, stale, or not externally verified). */
  unattributed: AttributionReceipt[];
}

export interface AttributeRevenueOptions {
  /** If set, an exposure older than this many ms before the payment is too stale to earn credit. */
  maxChainAgeMs?: number;
}

/**
 * Credit each receipt to the fleet artifact that caused it. The EARLIEST exposure per tracking ref is the
 * cause (first time the artifact was shown). A receipt is credited iff it is externally verified, carries a
 * known ref, and that ref's first exposure happened-before the payment (and within `maxChainAgeMs` if set).
 */
export function attributeRevenue(
  exposures: readonly Exposure[],
  receipts: readonly AttributionReceipt[],
  opts: AttributeRevenueOptions = {},
): AttributeRevenueResult {
  const firstExposureByRef = new Map<string, Exposure>();
  for (const e of exposures) {
    const existing = firstExposureByRef.get(e.trackingRef);
    if (!existing || e.occurredAtMs < existing.occurredAtMs) {
      firstExposureByRef.set(e.trackingRef, e);
    }
  }

  const attributed: AttributedRevenueEvent[] = [];
  const unattributed: AttributionReceipt[] = [];

  for (const r of receipts) {
    // L1: no external receipt, no number — an unverified receipt earns no credit.
    if (!r.verified) {
      unattributed.push(r);
      continue;
    }
    if (r.trackingRef === null || r.trackingRef.trim().length === 0) {
      unattributed.push(r);
      continue;
    }
    const exposure = firstExposureByRef.get(r.trackingRef);
    if (!exposure) {
      unattributed.push(r);
      continue;
    }
    // L2: credit by happened-before — no backward causality. An artifact shown AFTER the payment
    // cannot have caused it.
    if (exposure.occurredAtMs > r.occurredAtMs) {
      unattributed.push(r);
      continue;
    }
    if (
      opts.maxChainAgeMs !== undefined &&
      r.occurredAtMs - exposure.occurredAtMs > opts.maxChainAgeMs
    ) {
      unattributed.push(r);
      continue;
    }
    attributed.push({
      providerEventId: r.providerEventId,
      artifactId: exposure.artifactId,
      artifactKind: exposure.artifactKind,
      channel: exposure.channel,
      trackingRef: r.trackingRef,
      amountCents: r.amountCents,
      currency: r.currency,
      exposureAtMs: exposure.occurredAtMs,
      paidAtMs: r.occurredAtMs,
    });
  }

  return { attributed, unattributed };
}

/** Per-artifact attributed revenue, ranked by revenue-weighted outcome (L3 / PageRank). */
export interface ArtifactRevenue {
  artifactId: string;
  artifactKind: string;
  channel: string;
  attributedCents: number;
  currency: string;
  paymentCount: number;
}

/** Roll attributed events up per (artifact, currency) and rank by receipted dollars descending. */
export function rollupByArtifact(events: readonly AttributedRevenueEvent[]): ArtifactRevenue[] {
  const byArtifact = new Map<string, ArtifactRevenue>();
  for (const e of events) {
    const key = `${e.artifactId} ${e.currency}`;
    const cur = byArtifact.get(key);
    if (cur) {
      cur.attributedCents += e.amountCents;
      cur.paymentCount += 1;
    } else {
      byArtifact.set(key, {
        artifactId: e.artifactId,
        artifactKind: e.artifactKind,
        channel: e.channel,
        attributedCents: e.amountCents,
        currency: e.currency,
        paymentCount: 1,
      });
    }
  }
  return [...byArtifact.values()].sort((a, b) => b.attributedCents - a.attributedCents);
}

/**
 * Build the branded {@link ExternalDemandEvidence} for the `paid` apex of the chain from a verified
 * receipt — routing #386 through the existing #101 provenance brand so a self-generated "payment" can
 * never be presented as demand evidence. Returns `null` for an unverified receipt (L1).
 */
export function paidEvidenceFromReceipt(r: AttributionReceipt): ExternalDemandEvidence | null {
  if (!r.verified) return null;
  return externalDemandEvidence({
    signalClass: "paid",
    provenance: {
      kind: "externally_attributed",
      attribution: { source: "checkout", externalRef: r.providerEventId },
    },
    amountCents: r.amountCents,
    currency: r.currency,
  });
}
