/**
 * Provider seam for revenue collection (issue #98, ADR-0043), mirroring the #73 `DeployProvider` and the
 * #25 `SandboxProvider`. The real Stripe adapter implements this behind a dynamic import (see
 * ./stripe-provider.ts) so the `stripe` SDK is an OPTIONAL dependency the test/CI path never loads; the
 * default `NoneBillingProvider` implements the whole surface with zero network so tests, CI, and the demo
 * run for free.
 *
 * INBOUND ONLY — by design this interface has **no** `refund`/`payout`/`transfer` method. Outbound money
 * cannot be expressed through the seam (the structural half of the #98 safety rail); it is a #13
 * approval-gated, recorded-only action (see ./safety.ts). The two capabilities here only ever COLLECT.
 */

/** Recurring interval for a price; `null`/absent = a one-time charge. */
export type PriceInterval = "day" | "week" | "month" | "year";

export interface CreateProductPriceInput {
  /** Human-facing product name (e.g. "Pro plan"). */
  name: string;
  /** Unit amount in the smallest currency unit (cents). */
  amountCents: number;
  /** ISO 4217 currency code (e.g. "usd"). */
  currency: string;
  /** Recurring interval, or null for a one-time price. */
  interval: PriceInterval | null;
  /** Per-tenant provider credentials (e.g. STRIPE_SECRET_KEY); never logged. */
  secrets: Record<string, string>;
}

export interface ProductPrice {
  productId: string;
  priceId: string;
}

export interface CreatePaymentLinkInput {
  /** The price to charge (from {@link CreateProductPriceInput}). */
  priceId: string;
  /** A stable, URL-ish slug the no-network provider mints a link from. */
  slug: string;
  /** Metadata echoed back on the webhook so the manager can re-scope the revenue event (channel/session). */
  metadata: Record<string, string>;
  /** Optional payer contact to carry through checkout/webhook metadata for support, renewals, and dunning. */
  customerEmail?: string;
  /**
   * Where to send the customer **after** a successful payment (an in-app URL like
   * `https://app.ipop.ai/?checkout=success`). When set, the hosted link redirects back here so the SPA can
   * reflect the new plan/cap on return; when absent the provider's own confirmation page is the terminal.
   * Validated (http/https) by the caller — never logged.
   */
  returnUrl?: string;
  /** Per-tenant provider credentials; never logged. */
  secrets: Record<string, string>;
}

export interface PaymentLinkResult {
  /** The provider's id for the payment link / checkout session. */
  providerLinkId: string;
  /** The hosted URL a customer pays at. */
  url: string;
}

/**
 * The inbound-only billing seam. `createProductPrice` + `createPaymentLink` set up collection; there is
 * deliberately no way to move money out. Errors are thrown raw — the {@link
 * import("./manager.js").BillingManager} redacts them before anything is persisted or published.
 */
export interface BillingProvider {
  /** Stable provider kind (`none` | `stripe`). */
  readonly kind: string;
  /** Create a product + price to charge for. */
  createProductPrice(input: CreateProductPriceInput): Promise<ProductPrice>;
  /** Create a hosted payment link / checkout session for a price. */
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult>;
}
