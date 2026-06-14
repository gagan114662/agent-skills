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
import { BRAND, FAQ, LANDING, PRICING, VOICE } from "../../brand.js";
import { Link } from "../../routing.js";
import { Wordmark } from "../Wordmark.js";
import { PopMark } from "../PopMark.js";

/** The pricing questions, drawn from the shared FAQ by matching question text — no copy duplicated. */
function pricingFaq(): readonly { q: string; a: string }[] {
  return FAQ.items.filter((item) => PRICING.faqMatch.some((re) => re.test(item.q)));
}

export function PricingPage(): React.JSX.Element {
  return (
    <div className="pricing-page">
      <header className="landing__nav">
        <Link href="/" className="landing__brand" aria-label={BRAND.name}>
          <Wordmark />
        </Link>
        <nav className="landing__nav-actions">
          <Link href="/login" className="linklike">
            {LANDING.hero.ctaSecondary}
          </Link>
          <Link href="/signup" className="btn btn--primary landing__nav-cta">
            {LANDING.hero.ctaPrimary}
          </Link>
        </nav>
      </header>

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
                  <span className="pricing-card__amount">{plan.price}</span>
                  <span className="pricing-card__period">{PRICING.perMonth}</span>
                </p>
                <p className="pricing-card__tagline">{plan.tagline}</p>
                <ul className="pricing-card__highlights">
                  {plan.highlights.map((h) => (
                    <li key={h} className="pricing-card__highlight">
                      {h}
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/signup?plan=${plan.key}`}
                  className={`btn pricing-card__cta${plan.featured ? " btn--primary" : ""}`}
                  aria-label={`${PRICING.planCta} — ${plan.name}`}
                >
                  {PRICING.planCta}
                </Link>
              </li>
            ))}
          </ul>
          <p className="pricing__footnote">{PRICING.footnote}</p>
        </section>

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
          <Link href="/signup" className="btn btn--primary landing__cta landing__final-cta">
            {LANDING.sections.ctaButton}
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
