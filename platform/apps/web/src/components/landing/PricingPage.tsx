/**
 * The dedicated public pricing page (#214) at `/pricing`. Before this, `/pricing` fell through `AuthGate`
 * to the full landing page, so a shared link, an ad destination, or an SEO result aimed at the price-
 * shopping visitor showed the whole homepage instead of a focused, scannable plan comparison.
 *
 * This is that focused destination: a short hero, the three plans side-by-side with "what you get"
 * bullets, and one CTA per plan that carries the chosen plan into signup (`/signup?plan=<key>`) so the
 * sign-up form can frame it as a free trial. Pricing copy + plans come from `brand.ts` (`LANDING.plans`
 * is the one pricing truth) so this page never duplicates a price. Public at every phase, code-split.
 *
 * Every word comes from `brand.ts`; brand.test scans this file for hardcoded brand strings.
 */
import { FAQ, LANDING, PRICING, REFUND_POLICY, VOICE } from "../../brand.js";
import { Link } from "../../routing.js";
import { trackAcquisitionEvent } from "../../acquisition-events.js";
import { PopMark } from "../PopMark.js";
import { useState } from "react";
import { LaunchReadiness } from "./LaunchReadiness.js";
import { PublicDoorNav } from "../onboarding/PublicDoorNav.js";

type BillingInterval = "month" | "year";

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
  return (
    <div className="pricing-page">
      <PublicDoorNav className="pricing-page__nav" />

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
            {LANDING.plans.map((plan, i) => (
              <li
                key={plan.key}
                className={`pricing-card pricing-card--pop${
                  plan.featured ? " pricing-card--featured" : ""
                }`}
                style={{ animationDelay: `${i * 90}ms` }}
              >
                {plan.featured && <span className="pricing-card__ribbon">{PRICING.popularBadge}</span>}
                <h2 className="pricing-card__name">{plan.name}</h2>
                <p className="pricing-card__price">
                  <span className="pricing-card__amount">
                    {isAnnual ? annualPrice(plan.price) : plan.price}
                  </span>
                  <span className="pricing-card__period">{isAnnual ? PRICING.perYear : PRICING.perMonth}</span>
                </p>
                <p className="pricing-card__tagline">{plan.tagline}</p>
                <div className="pricing-card__value" aria-label={`Everyday value for ${plan.name}`}>
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
                <Link
                  href={`/signup?plan=${plan.key}&billing=${billingInterval}`}
                  className={`btn pricing-card__cta${plan.featured ? " btn--primary" : ""}`}
                  aria-label={`${PRICING.planCta} — ${plan.name}`}
                  onClick={() =>
                    trackCta(
                      `/signup?plan=${plan.key}&billing=${billingInterval}`,
                      `pricing-plan-${plan.key}-${billingInterval}`,
                    )
                  }
                >
                  {PRICING.planCta}
                </Link>
              </li>
            ))}
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
          <Link href="/signup" className="btn btn--primary landing__cta landing__final-cta" onClick={() => trackCta("/signup", "pricing-final")}>
            {LANDING.sections.ctaButton}
          </Link>
          <Link href="/demo" className="btn landing__cta landing__cta--ghost">
            {LANDING.hero.ctaDemo}
          </Link>
        </section>
      </main>

      <footer className="landing__footer">
        <div className="landing__footer-bottom">
          <Link href="/" className="linklike landing__footer-link">
            {PRICING.backLabel}
          </Link>
          <p className="landing__signoff">{VOICE.signOff}</p>
        </div>
      </footer>
    </div>
  );
}

function annualPrice(monthlyPrice: string): string {
  const amount = Number(monthlyPrice.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return monthlyPrice;
  return `$${Math.round(amount * 10).toLocaleString("en-US")}`;
}
