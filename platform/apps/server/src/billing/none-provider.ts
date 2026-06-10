import type {
  BillingProvider,
  CreatePaymentLinkInput,
  CreateProductPriceInput,
  PaymentLinkResult,
  ProductPrice,
} from "./provider.js";

/**
 * The default, **no-network** billing provider (#98). It exercises the whole inbound surface — minting a
 * deterministic `https://pay.none.reload.test/<slug>` payment link + synthetic product/price ids and
 * recording its calls — so tests, CI, and the demo never touch a Stripe account and never spend. The real
 * backend is `StripeBillingProvider` behind a lazy import (`BILLING_PROVIDER=stripe`).
 *
 * `failNext` is the test seam for the redaction guarantee: it forces the next `createProductPrice` to
 * reject with a message (which a test seeds with a secret value), and the manager must redact it.
 */
export class NoneBillingProvider implements BillingProvider {
  readonly kind = "none";

  /** Calls recorded for assertions (no network side effects). */
  readonly products: CreateProductPriceInput[] = [];
  readonly links: CreatePaymentLinkInput[] = [];

  /** When set, the next `createProductPrice` rejects with this message (then resets). */
  failNext?: string;

  private seq = 0;

  createProductPrice(input: CreateProductPriceInput): Promise<ProductPrice> {
    this.products.push(input);
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = undefined;
      return Promise.reject(new Error(message));
    }
    const n = ++this.seq;
    return Promise.resolve({ productId: `prod_none_${n}`, priceId: `price_none_${n}` });
  }

  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult> {
    this.links.push(input);
    return Promise.resolve({
      providerLinkId: `plink_none_${++this.seq}`,
      url: `https://pay.none.reload.test/${input.slug}`,
    });
  }
}
