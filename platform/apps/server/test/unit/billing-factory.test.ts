import { describe, it, expect } from "vitest";
import { createBillingProvider } from "../../src/billing/factory.js";
import { NoneBillingProvider } from "../../src/billing/none-provider.js";
import { StripeBillingProvider } from "../../src/billing/stripe-provider.js";
import type { BillingProvider } from "../../src/billing/provider.js";

/**
 * Provider selection (#98), mirroring `createDeployProvider`/`createRuntime`. `none` is the default so
 * dev/CI make zero network calls; `stripe` returns the real adapter (its SDK is loaded lazily on first
 * call, so selecting it here never touches the `stripe` package). An injected provider always wins.
 */
describe("createBillingProvider (#98 — none default, stripe opt-in, injectable)", () => {
  it("defaults to the no-network NoneBillingProvider", () => {
    const p = createBillingProvider({ provider: "none", mode: "test", webhookToleranceSeconds: 300 });
    expect(p).toBeInstanceOf(NoneBillingProvider);
    expect(p.kind).toBe("none");
  });

  it("selects the StripeBillingProvider when configured (SDK not loaded — lazy)", () => {
    const p = createBillingProvider(
      { provider: "stripe", mode: "test", webhookToleranceSeconds: 300 },
      undefined,
      { STRIPE_SECRET_KEY: "sk_test_factory" },
    );
    expect(p).toBeInstanceOf(StripeBillingProvider);
    expect(p.kind).toBe("stripe");
  });

  it("threads the go-live mode into the Stripe adapter (#481)", () => {
    const p = createBillingProvider(
      { provider: "stripe", mode: "live", webhookToleranceSeconds: 300 },
      undefined,
      { STRIPE_SECRET_KEY: "sk_live_factory" },
    );
    expect((p as StripeBillingProvider).mode).toBe("live");
  });

  it("returns an injected provider unchanged (tests pass a fake)", () => {
    const fake: BillingProvider = {
      kind: "fake",
      createProductPrice: () => Promise.resolve({ productId: "p", priceId: "pr" }),
      createPaymentLink: () => Promise.resolve({ providerLinkId: "l", url: "https://x" }),
    };
    expect(
      createBillingProvider({ provider: "stripe", mode: "test", webhookToleranceSeconds: 300 }, fake),
    ).toBe(fake);
  });

  it("the BillingProvider seam exposes NO outbound-money method (inbound only)", () => {
    const p = createBillingProvider({ provider: "none", mode: "test", webhookToleranceSeconds: 300 });
    // Structural safety rail: refunds/payouts/transfers cannot be expressed through the seam.
    expect((p as Record<string, unknown>).refund).toBeUndefined();
    expect((p as Record<string, unknown>).payout).toBeUndefined();
    expect((p as Record<string, unknown>).transfer).toBeUndefined();
  });
});
