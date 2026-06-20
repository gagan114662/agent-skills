import { describe, it, expect } from "vitest";
import {
  mintTrackablePayLink,
  type MintTrackablePayLinkDeps,
  type PayLinkBilling,
  type PayLinkExposureRecorder,
  type PayLinkPlanResolver,
} from "../../src/leads/pay-link-service.js";
import type { CreatePaymentLinkInput, PaymentLinkResult } from "../../src/billing/provider.js";
import type { RecordExposureInput } from "../../src/attribution/store.js";
import { mintTrackingRef, recoverTrackingRef } from "../../src/attribution/tracking.js";

/** A fake inbound-only billing seam — records the mint calls, no Stripe, no money-out method to call. */
function fakeBilling(kind = "none"): PayLinkBilling & { calls: CreatePaymentLinkInput[] } {
  const calls: CreatePaymentLinkInput[] = [];
  return {
    kind,
    calls,
    createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult> {
      calls.push(input);
      return Promise.resolve({
        providerLinkId: `plink_${calls.length}`,
        url: `https://pay.${kind}.reload.test/${input.slug}`,
      });
    },
  };
}

/** A fake exposure store, idempotent on (workspaceId, trackingRef) like the real unique constraint. */
function fakeExposures(): PayLinkExposureRecorder & { rows: RecordExposureInput[] } {
  const rows: RecordExposureInput[] = [];
  return {
    rows,
    recordExposure(input: RecordExposureInput): Promise<{ id: string }> {
      const idx = rows.findIndex(
        (r) => r.workspaceId === input.workspaceId && r.trackingRef === input.trackingRef,
      );
      if (idx >= 0) return Promise.resolve({ id: `exp-${idx}` });
      rows.push(input);
      return Promise.resolve({ id: `exp-${rows.length - 1}` });
    },
  };
}

function fakePlans(known = new Set(["pro"])): PayLinkPlanResolver {
  return {
    resolve(_workspaceId: string, planId: string) {
      if (!known.has(planId)) return Promise.resolve(null);
      return Promise.resolve({
        priceId: `price_${planId}`,
        slug: `plan-${planId}`,
        secrets: { STRIPE_SECRET_KEY: "sk_test_x" },
      });
    },
  };
}

function buildDeps(over: Partial<MintTrackablePayLinkDeps> = {}): MintTrackablePayLinkDeps {
  return {
    billing: over.billing ?? fakeBilling(),
    exposures: over.exposures ?? fakeExposures(),
    plans: over.plans ?? fakePlans(),
    utmSource: over.utmSource ?? "ipop",
    now: over.now ?? (() => 7_000),
  };
}

describe("leads pay-link service — mintTrackablePayLink (GAP 3, ADR-0401)", () => {
  it("mints the link WITH {trackingRef} metadata, records an exposure, returns a tracked URL", async () => {
    const billing = fakeBilling();
    const exposures = fakeExposures();
    const deps = buildDeps({ billing, exposures });

    const result = await mintTrackablePayLink(deps, {
      workspaceId: "ws1",
      planId: "pro",
      leadOrArtifactId: "lead-7",
      channel: "email",
    });

    const expectedRef = mintTrackingRef({
      workspaceId: "ws1",
      artifactId: "lead-7",
      channel: "email",
    });
    expect(result).not.toBeNull();
    expect(result?.trackingRef).toBe(expectedRef);

    // metadata carries the ref (round-tripped on the #98 webhook → GAP 2).
    expect(billing.calls).toHaveLength(1);
    expect(billing.calls[0]?.metadata).toEqual({ trackingRef: expectedRef });
    expect(billing.calls[0]?.priceId).toBe("price_pro");

    // the URL carries the ref too (recovered on landing).
    expect(recoverTrackingRef(result!.url)).toBe(expectedRef);

    // the pay link shown to the lead is recorded as an exposure at the clock instant.
    expect(exposures.rows).toHaveLength(1);
    expect(exposures.rows[0]).toMatchObject({
      workspaceId: "ws1",
      artifactId: "lead-7",
      artifactKind: "pay_link",
      trackingRef: expectedRef,
      channel: "email",
      occurredAtMs: 7_000,
    });
  });

  it("is idempotent on the ref — re-minting for the same lead records ONE exposure", async () => {
    const exposures = fakeExposures();
    const deps = buildDeps({ exposures });
    const input = {
      workspaceId: "ws1",
      planId: "pro",
      leadOrArtifactId: "lead-7",
      channel: "email" as const,
    };
    await mintTrackablePayLink(deps, input);
    await mintTrackablePayLink(deps, input);
    expect(exposures.rows).toHaveLength(1);
  });

  it("returns null for an unknown plan — no link, no exposure (body stays unchanged upstream)", async () => {
    const billing = fakeBilling();
    const exposures = fakeExposures();
    const deps = buildDeps({ billing, exposures, plans: fakePlans(new Set(["pro"])) });
    const result = await mintTrackablePayLink(deps, {
      workspaceId: "ws1",
      planId: "enterprise",
      leadOrArtifactId: "lead-7",
      channel: "email",
    });
    expect(result).toBeNull();
    expect(billing.calls).toHaveLength(0);
    expect(exposures.rows).toHaveLength(0);
  });

  it("surfaces the provider kind (none ⇒ non-live placeholder URL)", async () => {
    const deps = buildDeps({ billing: fakeBilling("none") });
    const result = await mintTrackablePayLink(deps, {
      workspaceId: "ws1",
      planId: "pro",
      leadOrArtifactId: "lead-7",
      channel: "email",
    });
    expect(result?.provider).toBe("none");
    expect(result?.url.startsWith("https://pay.none.reload.test/")).toBe(true);
  });
});
