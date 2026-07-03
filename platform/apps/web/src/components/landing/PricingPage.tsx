/**
 * The dedicated public pricing page (#214) at `/pricing`. Before this, `/pricing` fell through `AuthGate`
 * to the full landing page, so a shared link, an ad destination, or an SEO result aimed at the price-
 * shopping visitor showed the whole homepage instead of a focused, scannable plan comparison.
 *
 * This is that focused destination: a short hero, the three plans side-by-side with "what you get"
 * bullets, and one CTA per plan. Each CTA reaches that plan's Stripe Payment Link (`buy.stripe.com`) hosted
 * checkout when configured (#1550, {@link ../../pricing-checkout}), falling back to the `/signup?plan=<key>`
 * hand-off otherwise — never a dead link. A `?plan=<key>` deep link (the dashboard upsell) visibly
 * preselects the matching card. Pricing copy + plans come from `brand.ts` (`LANDING.plans` is the one
 * pricing truth) so this page never duplicates a price. Public at every phase, code-split.
 *
 * Every word comes from `brand.ts`; brand.test scans this file for hardcoded brand strings.
 */
import { FAQ, LANDING, PRICING, REFUND_POLICY } from "../../brand.js";
import { Link } from "../../routing.js";
import { trackAcquisitionEvent } from "../../acquisition-events.js";
import { PopMark } from "../PopMark.js";
import { useEffect, useRef, useState } from "react";
import { LaunchReadiness } from "./LaunchReadiness.js";
import { PublicDoorFooter, PublicDoorNav } from "../onboarding/PublicDoorNav.js";
import { TELEGRAM_BOT_URL } from "../onboarding/messaging-entry.js";
import { publicThemeStyle } from "../../design/public-theme.js";
import { planCheckoutHref, type BillingInterval, type PlanKey } from "../../pricing-checkout.js";

/**
 * #1550: a plan chosen elsewhere (the dashboard "View Pro" upsell links to `/pricing?plan=pro`) arrives as
 * `?plan=<key>`. Resolve it to a known plan key so the matching card can be visibly preselected — before
 * this the deep link was a no-op. SSR-safe: no `window` read on the server render.
 */
function preselectedPlanFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const key = new URLSearchParams(window.location.search).get("plan");
  return key && LANDING.plans.some((plan) => plan.key === key) ? key : null;
}

/** The pricing questions, drawn from the shared FAQ by matching question text — no copy duplicated. */
function pricingFaq(): readonly { q: string; a: string }[] {
  return FAQ.items.filter((item) => PRICING.faqMatch.some((re) => re.test(item.q)));
}

function trackCta(href: string, source: string): void {
  trackAcquisitionEvent("cta-click", { url: href, source });
}

export function PricingPage(): React.JSX.Element {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("month");
  const isAnnual = billingInterval === "year";
  // #1550: preselect + scroll to the card named by `?plan=<key>` so the dashboard upsell deep link lands
  // on (and highlights) the right tier instead of doing nothing.
  const [preselectedPlan] = useState<string | null>(preselectedPlanFromUrl);
  const preselectedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    // `scrollIntoView` is undefined under jsdom — optional-chain the call so tests never throw.
    preselectedRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, []);
  return (
    <div className="pricing-page public-surface" style={publicThemeStyle(["o"])}>
      <PublicDoorNav className="pricing-page__nav" startHref={TELEGRAM_BOT_URL} />

      <main>
        <section className="pricing-page__hero" aria-labelledby="pricing-title">
          <PopMark burst className="landing__popmark" />
          <p className="landing__eyebrow">{PRICING.eyebrow}</p>
          <h1 id="pricing-title" className="pricing__title">
            {PRICING.title}
          </h1>
          <p className="landing__section-sub">{PRICING.sub}</p>
        </section>

        <section className="pricing" aria-label={PRICING.plansLabel}>
          <div className="pricing-page__cadence" role="group" aria-label="Billing cadence">
            <button
              type="button"
              className={`pricing-page__cadence-option${!isAnnual ? " is-active" : ""}`}
              aria-pressed={!isAnnual}
              onClick={() => setBillingInterval("month")}
            >
              {PRICING.monthlyLabel}
            </button>
            <button
              type="button"
              className={`pricing-page__cadence-option${isAnnual ? " is-active" : ""}`}
              aria-pressed={isAnnual}
              onClick={() => setBillingInterval("year")}
            >
              {PRICING.annualLabel}
              <span>{PRICING.annualBadge}</span>
            </button>
          </div>
          <ul className="pricing__grid">
            {LANDING.plans.map((plan, i) => {
              const isPreselected = plan.key === preselectedPlan;
              const checkoutHref = planCheckoutHref(plan.key as PlanKey, billingInterval);
              return (
                <li
                  key={plan.key}
                  ref={isPreselected ? preselectedRef : undefined}
                  aria-current={isPreselected ? "true" : undefined}
                  className={`pricing-card pricing-card--pop${
                    plan.featured ? " pricing-card--featured" : ""
                  }${isPreselected ? " pricing-card--selected" : ""}`}
                  style={{ animationDelay: `${i * 90}ms` }}
                >
                  {plan.featured && (
                    <span className="pricing-card__ribbon">{PRICING.popularBadge}</span>
                  )}
                  <h2 className="pricing-card__name">{plan.name}</h2>
                  <p className="pricing-card__price">
                    <span className="pricing-card__amount">
                      {isAnnual ? annualPrice(plan.price) : plan.price}
                    </span>
                    <span className="pricing-card__period">
                      {isAnnual ? PRICING.perYear : PRICING.perMonth}
                    </span>
                  </p>
                  <p className="pricing-card__tagline">{plan.tagline}</p>
                  <div
                    className="pricing-card__value"
                    aria-label={`Everyday value for ${plan.name}`}
                  >
                    <p className="pricing-card__value-label">Every day</p>
                    <p className="pricing-card__value-copy">{plan.dailyValue}</p>
                  </div>
                  <div className="pricing-card__limit">
                    <p>
                      <span>Limit:</span> {plan.dailyLimit}
                    </p>
                    <p>
                      <span>Upgrade:</span> {plan.upgradeTrigger}
                    </p>
                  </div>
                  <ul className="pricing-card__highlights">
                    {plan.highlights.map((h) => (
                      <li key={h} className="pricing-card__highlight">
                        {h}
                      </li>
                    ))}
                  </ul>
                  <a
                    href={checkoutHref}
                    className={`btn pricing-card__cta${plan.featured ? " btn--primary" : ""}`}
                    aria-label={`${PRICING.planCta} — ${plan.name}`}
                    onClick={() =>
                      trackCta(checkoutHref, `pricing-plan-${plan.key}-${billingInterval}`)
                    }
                  >
                    {PRICING.planCta}
                  </a>
                </li>
              );
            })}
          </ul>
          <p className="pricing__footnote">
            {PRICING.footnote}{" "}
            <Link href="/refund-policy" className="linklike">
              {REFUND_POLICY.navLabel}
            </Link>
          </p>
        </section>

        <LaunchReadiness />

        <section className="pricing-page__faq landing__section" aria-labelledby="pricing-faq-title">
          <h2 id="pricing-faq-title" className="landing__section-title">
            {PRICING.faqTitle}
          </h2>
          <div className="faq__list">
            {pricingFaq().map((item) => (
              <details key={item.q} className="faq__item" open>
                <summary className="faq__q">
                  {item.q}
                  <span className="faq__chev" aria-hidden="true" />
                </summary>
                <p className="faq__a">{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="landing__section landing__final" aria-labelledby="pricing-final-title">
          <h2 id="pricing-final-title" className="landing__final-title">
            {LANDING.sections.ctaTitle}
          </h2>
          <p className="landing__final-sub">{LANDING.sections.ctaSub}</p>
          <a
            href="/signup"
            className="btn btn--primary landing__cta landing__final-cta"
            onClick={() => trackCta("/signup", "pricing-final")}
          >
            {LANDING.sections.ctaButton}
          </a>
          <Link href="/demo" className="btn landing__cta landing__cta--ghost">
            {LANDING.hero.ctaDemo}
          </Link>
        </section>
      </main>

      <PublicDoorFooter className="pricing-page__footer" />
    </div>
  );
}

function annualPrice(monthlyPrice: string): string {
  const amount = Number(monthlyPrice.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return monthlyPrice;
  return `$${Math.round(amount * 10).toLocaleString("en-US")}`;
}
