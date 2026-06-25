import type {
  BillingProvider,
  CreatePaymentLinkInput,
  CreateProductPriceInput,
  PaymentLinkResult,
  ProductPrice,
} from "./provider.js";
import { assertKeyMatchesMode, type BillingMode } from "./mode.js";

/**
 * Production adapter mapping {@link BillingProvider} onto Stripe (the official `stripe` npm SDK). This is
 * the revenue backend: a real product + price + hosted payment link, charged in real money.
 *
 * The SDK is loaded via a *dynamic import behind a runtime variable* so it stays an OPTIONAL dependency:
 * the test/CI path uses `NoneBillingProvider` and never loads it, and the lockfile isn't forced to carry
 * it. To use the `stripe` backend:
 *   1. Install it:  pnpm --filter @reload/server add stripe
 *   2. Provide STRIPE_SECRET_KEY (+ STRIPE_WEBHOOK_SECRET) per tenant on the #25 AGENT_SECRETS path.
 *   3. Set BILLING_PROVIDER=stripe (and, to take real money, BILLING_MODE=live — see below).
 *
 * GO-LIVE (#481): the adapter carries the declared {@link BillingMode} and, before the SDK ever loads,
 * asserts the supplied `STRIPE_SECRET_KEY`'s prefix matches it (`sk_live_…` ⇄ live, `sk_test_…` ⇄ test).
 * A mismatch FAILS CLOSED ({@link import("./mode.js").BillingModeMismatchError}) so a test key can't sit
 * in production (zero real revenue) and a live key can't sit in staging (accidental real charges).
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
      after_completion?: { type: "redirect"; redirect: { url: string } };
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

/** The SDK loader seam — defaults to the lazy dynamic import; tests inject a mock module. */
export type StripeModuleLoader = () => Promise<StripeSdkModule>;

const defaultModuleLoader: StripeModuleLoader = async () => {
  const specifier = "stripe";
  return (await import(specifier)) as unknown as StripeSdkModule;
};

async function loadClient(
  secrets: Record<string, string>,
  mode: BillingMode,
  loadModule: StripeModuleLoader,
): Promise<StripeClient> {
  const apiKey = secrets[SECRET_KEY_NAME];
  if (!apiKey) throw authError();
  // Go-live guard (#481): refuse a key whose mode contradicts the declared BILLING_MODE — BEFORE any
  // network or SDK load, and without ever logging the key value.
  assertKeyMatchesMode(mode, apiKey);
  let mod: StripeSdkModule;
  try {
    mod = await loadModule();
  } catch {
    throw authError();
  }
  return new mod.default(apiKey);
}

/**
 * The provider used when `BILLING_PROVIDER=stripe`. Lazily loads the SDK on first call. The declared
 * `mode` (#481) gates real money; an optional `loadModule` is the test-only SDK seam (production uses the
 * dynamic import).
 */
export class StripeBillingProvider implements BillingProvider {
  readonly kind = "stripe";

  constructor(
    readonly mode: BillingMode = "test",
    private readonly loadModule: StripeModuleLoader = defaultModuleLoader,
  ) {}

  async createProductPrice(input: CreateProductPriceInput): Promise<ProductPrice> {
    const client = await loadClient(input.secrets, this.mode, this.loadModule);
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
    const client = await loadClient(input.secrets, this.mode, this.loadModule);
    const link = await client.paymentLinks.create({
      line_items: [{ price: input.priceId, quantity: 1 }],
      metadata: {
        ...input.metadata,
        ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
      },
      // Send the payer back into the app (so the SPA reflects the new plan) when a return URL is supplied.
      ...(input.returnUrl
        ? { after_completion: { type: "redirect" as const, redirect: { url: input.returnUrl } } }
        : {}),
    });
    return { providerLinkId: link.id, url: link.url };
  }
}
