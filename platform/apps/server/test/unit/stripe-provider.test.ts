import { describe, it, expect } from "vitest";
import { StripeBillingProvider } from "../../src/billing/stripe-provider.js";
import { BillingModeMismatchError } from "../../src/billing/mode.js";

/**
 * #481 go-live: the real Stripe adapter exercised against a MOCK Stripe SDK module (injected via the
 * test-only loader seam) so the full inbound flow — create product+price, mint a payment link with
 * round-tripped metadata + return redirect — is covered without the `stripe` package or any network. Also
 * proves the go-live key-mode guard fails closed BEFORE the SDK is ever loaded.
 */

interface Recorder {
  apiKey?: string;
  products: unknown[];
  prices: unknown[];
  links: unknown[];
}

/** A fake `stripe` SDK module whose `default` constructor returns a hand-rolled client + records calls. */
function fakeStripeModule(rec: Recorder) {
  const client = {
    products: {
      create: async (args: { name: string }) => {
        rec.products.push(args);
        return { id: "prod_TEST" };
      },
    },
    prices: {
      create: async (args: unknown) => {
        rec.prices.push(args);
        return { id: "price_TEST" };
      },
    },
    paymentLinks: {
      create: async (args: unknown) => {
        rec.links.push(args);
        return { id: "plink_TEST", url: "https://pay.stripe.com/test_link" };
      },
    },
  };
  // `new mod.default(apiKey)` → a function that returns an object makes `new` yield that object.
  const ctor = function (apiKey: string) {
    rec.apiKey = apiKey;
    return client;
  };
  return { default: ctor as unknown as new (apiKey: string) => typeof client };
}

function newRecorder(): Recorder {
  return { products: [], prices: [], links: [] };
}

describe("StripeBillingProvider (#481 — go-live adapter against a mock Stripe SDK)", () => {
  it("creates a recurring product+price and passes the live key through to the SDK", async () => {
    const rec = newRecorder();
    const provider = new StripeBillingProvider("live", async () => fakeStripeModule(rec));

    const result = await provider.createProductPrice({
      name: "ipop Pro",
      amountCents: 19_900,
      currency: "usd",
      interval: "month",
      secrets: { STRIPE_SECRET_KEY: "sk_live_REALKEY" },
    });

    expect(result).toEqual({ productId: "prod_TEST", priceId: "price_TEST" });
    expect(rec.apiKey).toBe("sk_live_REALKEY");
    expect(rec.products).toEqual([{ name: "ipop Pro" }]);
    expect(rec.prices).toEqual([
      { product: "prod_TEST", unit_amount: 19_900, currency: "usd", recurring: { interval: "month" } },
    ]);
  });

  it("omits the recurring block for a one-time price (interval null)", async () => {
    const rec = newRecorder();
    const provider = new StripeBillingProvider("test", async () => fakeStripeModule(rec));

    await provider.createProductPrice({
      name: "One-off",
      amountCents: 500,
      currency: "usd",
      interval: null,
      secrets: { STRIPE_SECRET_KEY: "sk_test_abc" },
    });

    expect(rec.prices).toEqual([{ product: "prod_TEST", unit_amount: 500, currency: "usd" }]);
  });

  it("mints a payment link with metadata and a post-payment redirect", async () => {
    const rec = newRecorder();
    const provider = new StripeBillingProvider("live", async () => fakeStripeModule(rec));

    const link = await provider.createPaymentLink({
      priceId: "price_TEST",
      slug: "plan-pro-ws1",
      metadata: { workspaceId: "ws1", planKey: "pro", kind: "plan_checkout" },
      returnUrl: "https://app.ipop.ai/?checkout=success",
      secrets: { STRIPE_SECRET_KEY: "sk_live_REALKEY" },
    });

    expect(link).toEqual({ providerLinkId: "plink_TEST", url: "https://pay.stripe.com/test_link" });
    expect(rec.links).toEqual([
      {
        line_items: [{ price: "price_TEST", quantity: 1 }],
        metadata: { workspaceId: "ws1", planKey: "pro", kind: "plan_checkout" },
        after_completion: { type: "redirect", redirect: { url: "https://app.ipop.ai/?checkout=success" } },
      },
    ]);
  });

  it("FAILS CLOSED on a mode mismatch BEFORE the SDK is loaded (test key in live mode)", async () => {
    const rec = newRecorder();
    let loaderCalled = false;
    const provider = new StripeBillingProvider("live", async () => {
      loaderCalled = true;
      return fakeStripeModule(rec);
    });

    await expect(
      provider.createProductPrice({
        name: "ipop Pro",
        amountCents: 19_900,
        currency: "usd",
        interval: "month",
        secrets: { STRIPE_SECRET_KEY: "sk_test_WRONGMODE" },
      }),
    ).rejects.toBeInstanceOf(BillingModeMismatchError);
    // The guard runs before any SDK import — the loader must never have been touched.
    expect(loaderCalled).toBe(false);
  });

  it("throws an actionable error (not a mode error) when no key is supplied", async () => {
    const provider = new StripeBillingProvider("live", async () => fakeStripeModule(newRecorder()));
    await expect(
      provider.createProductPrice({
        name: "x",
        amountCents: 100,
        currency: "usd",
        interval: null,
        secrets: {},
      }),
    ).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });
});
