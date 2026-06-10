import type {
  BillingProvider,
  CreatePaymentLinkInput,
  CreateProductPriceInput,
  PaymentLinkResult,
  ProductPrice,
} from "./provider.js";

/**
 * Production adapter mapping {@link BillingProvider} onto Stripe (the official `stripe` npm SDK). This is
 * the revenue backend: a real product + price + hosted payment link, charged in real money.
 *
 * The SDK is loaded via a *dynamic import behind a runtime variable* so it stays an OPTIONAL dependency:
 * the test/CI path uses `NoneBillingProvider` and never loads it, and the lockfile isn't forced to carry
 * it. To use the `stripe` backend:
 *   1. Install it:  pnpm --filter @reload/server add stripe
 *   2. Provide STRIPE_SECRET_KEY (+ STRIPE_WEBHOOK_SECRET) per tenant on the #25 AGENT_SECRETS path.
 *   3. Set BILLING_PROVIDER=stripe.
 *
 * INBOUND ONLY: this adapter creates products/prices/payment links — it has no path that refunds, pays
 * out, or transfers. Outbound money is a #13 approval-gated, recorded-only action (see ./safety.ts).
 * Credentials come from the per-tenant secrets the manager injects (never from config); the manager
 * redacts their values from any error before it is persisted or published.
 */

/** The slice of the Stripe SDK surface we use. */
interface StripeClient {
  products: { create(args: { name: string }): Promise<{ id: string }> };
  prices: {
    create(args: {
      product: string;
      unit_amount: number;
      currency: string;
      recurring?: { interval: string };
    }): Promise<{ id: string }>;
  };
  paymentLinks: {
    create(args: {
      line_items: { price: string; quantity: number }[];
      metadata?: Record<string, string>;
    }): Promise<{ id: string; url: string }>;
  };
}

interface StripeSdkModule {
  default: new (apiKey: string, opts?: { apiVersion?: string }) => StripeClient;
}

const SECRET_KEY_NAME = "STRIPE_SECRET_KEY";

function authError(): Error {
  return new Error(
    "BILLING_PROVIDER=stripe requires the 'stripe' package and a per-tenant STRIPE_SECRET_KEY. Install " +
      "it (pnpm --filter @reload/server add stripe), put STRIPE_SECRET_KEY on the AGENT_SECRETS path, " +
      "or run with BILLING_PROVIDER=none.",
  );
}

async function loadClient(secrets: Record<string, string>): Promise<StripeClient> {
  const apiKey = secrets[SECRET_KEY_NAME];
  if (!apiKey) throw authError();
  const specifier = "stripe";
  let mod: StripeSdkModule;
  try {
    mod = (await import(specifier)) as unknown as StripeSdkModule;
  } catch {
    throw authError();
  }
  return new mod.default(apiKey);
}

/** The provider used when `BILLING_PROVIDER=stripe`. Lazily loads the SDK on first call. */
export class StripeBillingProvider implements BillingProvider {
  readonly kind = "stripe";

  async createProductPrice(input: CreateProductPriceInput): Promise<ProductPrice> {
    const client = await loadClient(input.secrets);
    const product = await client.products.create({ name: input.name });
    const price = await client.prices.create({
      product: product.id,
      unit_amount: input.amountCents,
      currency: input.currency,
      ...(input.interval ? { recurring: { interval: input.interval } } : {}),
    });
    return { productId: product.id, priceId: price.id };
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult> {
    const client = await loadClient(input.secrets);
    const link = await client.paymentLinks.create({
      line_items: [{ price: input.priceId, quantity: 1 }],
      metadata: input.metadata,
    });
    return { providerLinkId: link.id, url: link.url };
  }
}
