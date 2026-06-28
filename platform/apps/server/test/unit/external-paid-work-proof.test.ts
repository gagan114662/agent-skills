import { describe, expect, it } from "vitest";
import {
  verifyExternalPaidWorkProof,
  type ExternalPaidWorkProof,
} from "../../src/founder-work/proof.js";

const baseProof: ExternalPaidWorkProof = {
  opportunity: {
    source: "public_bounty",
    sourceUrl: "https://example.org/bounties/growth-page",
    customerRef: "customer_acme",
    valueCents: 50_000,
    currency: "usd",
    externallySourced: true,
    selfMarketing: false,
  },
  deliverable: {
    kind: "landing_page",
    deliverableRef: "deliverable_123",
    verificationPassed: true,
    verificationReceipt: {
      source: "live_url",
      externalRef: "https://customer.example.org/growth-page",
      httpStatus: 200,
      observedAt: "2026-06-28T02:00:00.000Z",
    },
  },
  delivery: {
    approvalRequestId: "approval_13_123",
    receipt: {
      source: "production_readback",
      externalRef: "client-delivery-thread-123",
      observedAt: "2026-06-28T02:05:00.000Z",
      detail: { provider: "gmail" },
    },
  },
  payment: {
    provider: "stripe",
    providerEventId: "evt_external_paid_work_123",
    amountCents: 50_000,
    currency: "usd",
    customerRef: "customer_acme",
    receipt: {
      source: "production_readback",
      externalRef: "evt_external_paid_work_123",
      observedAt: "2026-06-28T02:30:00.000Z",
      detail: { provider: "stripe" },
    },
  },
};

describe("verifyExternalPaidWorkProof (#387 close gate)", () => {
  it("passes only when ipop fulfilled externally sourced paid work and received real payment", () => {
    const result = verifyExternalPaidWorkProof(baseProof);

    expect(result.proven).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it("rejects self-marketing, unverified delivery, missing approval, and fake payment proof", () => {
    const result = verifyExternalPaidWorkProof({
      opportunity: {
        source: "self_marketing",
        sourceUrl: "https://ipop.ai/",
        customerRef: "customer_acme",
        valueCents: 0,
        currency: "usd",
        externallySourced: false,
        selfMarketing: true,
      },
      deliverable: {
        kind: "landing_page",
        deliverableRef: "",
        verificationPassed: false,
        verificationReceipt: {
          source: "live_url",
          externalRef: "https://customer.example.org/broken",
          httpStatus: 503,
          observedAt: "2026-06-28T02:00:00.000Z",
        },
      },
      delivery: {
        approvalRequestId: "",
        receipt: {
          source: "production_readback",
          externalRef: "",
          observedAt: "2026-06-28T02:05:00.000Z",
        },
      },
      payment: {
        provider: "manual_claim",
        providerEventId: "",
        amountCents: 0,
        currency: "usd",
        customerRef: "customer_other",
        receipt: {
          source: "production_readback",
          externalRef: "",
          observedAt: "2026-06-28T02:30:00.000Z",
        },
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps.map((g) => g.requirement)).toEqual([
      "external_opportunity",
      "external_opportunity",
      "verified_deliverable",
      "verified_deliverable",
      "approved_delivery",
      "approved_delivery",
      "external_payment",
      "external_payment",
      "external_payment",
      "external_payment",
    ]);
  });
});
