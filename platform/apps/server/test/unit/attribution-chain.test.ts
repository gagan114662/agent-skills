import { describe, it, expect } from "vitest";
import {
  attributeRevenue,
  rollupByArtifact,
  paidEvidenceFromReceipt,
  type Exposure,
  type AttributionReceipt,
} from "../../src/attribution/chain.js";

const exposure = (over: Partial<Exposure> = {}): Exposure => ({
  artifactId: "blog/launch",
  artifactKind: "seo_page",
  trackingRef: "ipop_abc",
  channel: "seo",
  occurredAtMs: 1_000,
  ...over,
});

const receipt = (over: Partial<AttributionReceipt> = {}): AttributionReceipt => ({
  providerEventId: "evt_1",
  trackingRef: "ipop_abc",
  amountCents: 4900,
  currency: "usd",
  verified: true,
  occurredAtMs: 2_000,
  ...over,
});

describe("attribution/chain — attributeRevenue (credit by causality)", () => {
  it("credits a verified receipt to the artifact whose exposure happened-before it (L1+L2)", () => {
    const { attributed, unattributed } = attributeRevenue([exposure()], [receipt()]);
    expect(unattributed).toHaveLength(0);
    expect(attributed).toHaveLength(1);
    expect(attributed[0]).toMatchObject({
      artifactId: "blog/launch",
      trackingRef: "ipop_abc",
      amountCents: 4900,
      exposureAtMs: 1_000,
      paidAtMs: 2_000,
    });
  });

  it("does NOT credit an unverified receipt — no external receipt, no number (L1)", () => {
    const { attributed, unattributed } = attributeRevenue(
      [exposure()],
      [receipt({ verified: false })],
    );
    expect(attributed).toHaveLength(0);
    expect(unattributed).toHaveLength(1);
  });

  it("does NOT credit a receipt with no tracking ref", () => {
    const { attributed, unattributed } = attributeRevenue([exposure()], [receipt({ trackingRef: null })]);
    expect(attributed).toHaveLength(0);
    expect(unattributed).toHaveLength(1);
  });

  it("does NOT credit a receipt whose ref has no exposure", () => {
    const { attributed, unattributed } = attributeRevenue(
      [exposure({ trackingRef: "ipop_other" })],
      [receipt()],
    );
    expect(attributed).toHaveLength(0);
    expect(unattributed).toHaveLength(1);
  });

  it("rejects backward causality — an exposure AFTER the payment cannot have caused it (L2)", () => {
    const { attributed, unattributed } = attributeRevenue(
      [exposure({ occurredAtMs: 5_000 })],
      [receipt({ occurredAtMs: 2_000 })],
    );
    expect(attributed).toHaveLength(0);
    expect(unattributed).toHaveLength(1);
  });

  it("uses the EARLIEST exposure per ref as the cause", () => {
    const { attributed } = attributeRevenue(
      [exposure({ occurredAtMs: 1_500 }), exposure({ occurredAtMs: 500 })],
      [receipt()],
    );
    expect(attributed[0]?.exposureAtMs).toBe(500);
  });

  it("honors a max chain-age cap (a stale exposure does not earn credit)", () => {
    const { attributed, unattributed } = attributeRevenue(
      [exposure({ occurredAtMs: 0 })],
      [receipt({ occurredAtMs: 10_000 })],
      { maxChainAgeMs: 5_000 },
    );
    expect(attributed).toHaveLength(0);
    expect(unattributed).toHaveLength(1);
  });
});

describe("attribution/chain — rollupByArtifact (revenue-weighted ranking, L3)", () => {
  it("sums per-artifact attributed cents and ranks descending", () => {
    const exposures: Exposure[] = [
      exposure({ artifactId: "a", trackingRef: "ipop_a", occurredAtMs: 0 }),
      exposure({ artifactId: "b", trackingRef: "ipop_b", occurredAtMs: 0 }),
    ];
    const receipts: AttributionReceipt[] = [
      receipt({ providerEventId: "e1", trackingRef: "ipop_a", amountCents: 1000, occurredAtMs: 1 }),
      receipt({ providerEventId: "e2", trackingRef: "ipop_a", amountCents: 2000, occurredAtMs: 2 }),
      receipt({ providerEventId: "e3", trackingRef: "ipop_b", amountCents: 5000, occurredAtMs: 3 }),
    ];
    const { attributed } = attributeRevenue(exposures, receipts);
    const ranked = rollupByArtifact(attributed);
    expect(ranked.map((r) => r.artifactId)).toEqual(["b", "a"]);
    expect(ranked[0]).toMatchObject({ artifactId: "b", attributedCents: 5000, paymentCount: 1 });
    expect(ranked[1]).toMatchObject({ artifactId: "a", attributedCents: 3000, paymentCount: 2 });
  });
});

describe("attribution/chain — paidEvidenceFromReceipt (routes through the #101 provenance brand)", () => {
  it("builds external demand evidence for a verified receipt", () => {
    const ev = paidEvidenceFromReceipt(receipt());
    expect(ev).not.toBeNull();
    expect(ev?.signalClass).toBe("paid");
    expect(ev?.provenance.kind).toBe("externally_attributed");
  });

  it("returns null for an unverified receipt (cannot present self-generated payment as demand)", () => {
    expect(paidEvidenceFromReceipt(receipt({ verified: false }))).toBeNull();
  });
});
