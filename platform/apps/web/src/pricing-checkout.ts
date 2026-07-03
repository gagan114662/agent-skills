/**
 * Per-plan public checkout resolution (#1550) — the money path for the anonymous `/pricing` visitor.
 *
 * Before this, every plan CTA on `/pricing` pointed at `/signup?plan=<key>`, and signup dead-ended in a
 * "your workspace is ready" screen with no payment step — the whole monetisation funnel stopped there.
 * This module gives each plan card a CTA that reaches its own **Stripe Payment Link** (`buy.stripe.com`),
 * the anonymous-friendly, no-account-required hosted checkout Stripe mints per price. The owner creates one
 * link per plan × billing interval in the Stripe dashboard and wires them in at build time:
 *
 *   VITE_STRIPE_PAYMENT_LINK_STARTER_MONTH / _STARTER_YEAR  (or interval-agnostic _STARTER)
 *   VITE_STRIPE_PAYMENT_LINK_PRO_MONTH     / _PRO_YEAR      (or _PRO)
 *   VITE_STRIPE_PAYMENT_LINK_AGENCY_MONTH  / _AGENCY_YEAR   (or _AGENCY)
 *
 * SAFETY (#98 inbound-only + #200 + #243): a Payment Link only ever COLLECTS money — a buyer clicks and pays
 * through Stripe's own rails. It is not a charge/payout/refund (those money-OUT actions stay #13-gated), and
 * this module mints nothing and calls no API; it only chooses which pre-created hosted URL a link points at.
 *
 * FALLBACK: when a plan's link is not configured (dev, preview, or a deploy that hasn't set the secret yet)
 * we fall back to the pre-#1550 `/signup?plan=<key>&billing=<interval>` path so the CTA is never a dead `#`
 * and never regresses the existing signup hand-off. Configured links win; a malformed value is ignored.
 */
/** The billing cadence a visitor can pick before checkout — mirrors `billing/plans.ts`. */
export type BillingInterval = "month" | "year";

/** The three plan keys carried on `/pricing` — mirrors `billing/plans.ts` `PlanKey`. */
export type PlanKey = "starter" | "pro" | "agency";

/**
 * A configured Payment Link only counts if it is an absolute `https://buy.stripe.com/…` URL. This keeps a
 * stray value (a relative path, an unrelated host, an accidental non-Stripe link) from ever becoming the
 * checkout destination — a malformed value falls through to the `/signup` fallback instead.
 */
export function isStripePaymentLink(value: string | undefined | null): value is string {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === "buy.stripe.com";
}

/** The signup hand-off used when no Payment Link is configured (pre-#1550 behaviour, never a dead link). */
export function signupFallbackHref(planKey: PlanKey, interval: BillingInterval): string {
  return `/signup?plan=${planKey}&billing=${interval}`;
}

/**
 * The configured Payment Links, read from `import.meta.env` at call time. Every read is a *literal* static
 * `import.meta.env.VITE_…` member access so Vite inlines it in the production build (aliasing or dynamic
 * bracket access would not be replaced) while `vi.stubEnv` can still override it under vitest.
 */
function configuredLink(planKey: PlanKey, interval: BillingInterval): string | undefined {
  switch (planKey) {
    case "starter":
      return (
        (interval === "year"
          ? import.meta.env.VITE_STRIPE_PAYMENT_LINK_STARTER_YEAR
          : import.meta.env.VITE_STRIPE_PAYMENT_LINK_STARTER_MONTH) ??
        import.meta.env.VITE_STRIPE_PAYMENT_LINK_STARTER
      );
    case "pro":
      return (
        (interval === "year"
          ? import.meta.env.VITE_STRIPE_PAYMENT_LINK_PRO_YEAR
          : import.meta.env.VITE_STRIPE_PAYMENT_LINK_PRO_MONTH) ??
        import.meta.env.VITE_STRIPE_PAYMENT_LINK_PRO
      );
    case "agency":
      return (
        (interval === "year"
          ? import.meta.env.VITE_STRIPE_PAYMENT_LINK_AGENCY_YEAR
          : import.meta.env.VITE_STRIPE_PAYMENT_LINK_AGENCY_MONTH) ??
        import.meta.env.VITE_STRIPE_PAYMENT_LINK_AGENCY
      );
    default:
      return undefined;
  }
}

/**
 * The href a plan card CTA should carry: the plan's configured `buy.stripe.com` Payment Link for the chosen
 * billing interval when one is set (and valid), otherwise the `/signup?plan=…&billing=…` fallback. Pure —
 * a deterministic function of (plan, interval, env), safe to call during SSR and in tests.
 */
export function planCheckoutHref(planKey: PlanKey, interval: BillingInterval): string {
  const link = configuredLink(planKey, interval);
  return isStripePaymentLink(link) ? link : signupFallbackHref(planKey, interval);
}

/** True iff this plan's CTA resolves to a real Stripe Payment Link (not the signup fallback). */
export function hasStripePaymentLink(planKey: PlanKey, interval: BillingInterval): boolean {
  return isStripePaymentLink(configuredLink(planKey, interval));
}
