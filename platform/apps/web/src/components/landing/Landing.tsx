/**
 * The public marketing homepage (#149) — what a logged-out visitor sees at `/`. The product console
 * lives behind auth; this is the storefront: an animated hero with the Pop Mark and a looping staged
 * chat vignette, then how-it-works, the department roster, a pricing teaser, and a closing call-to-action.
 *
 * Strictly per the committed brand book (docs/brand/ipop-brand-identity.html): Paper/Ink/Vermilion, the
 * popped-i wordmark, the pop easing on every move, all gated behind prefers-reduced-motion. Every word
 * comes from `brand.ts` (BRAND/LANDING/FLEET/VOICE) so there are no hardcoded brand strings — brand.test
 * scans this directory for the rule.
 */
import { BRAND, FLEET, LANDING, VOICE, agentColor } from "../../brand.js";
import { Link } from "../../routing.js";
import { Wordmark } from "../Wordmark.js";
import { PopMark } from "../PopMark.js";
import { HeroVignette } from "./HeroVignette.js";

export function Landing(): React.JSX.Element {
  return (
    <div className="landing">
      <LandingNav />
      <main>
        <Hero />
        <HowItWorks />
        <Department />
        <PricingTeaser />
        <ClosingCta />
      </main>
      <LandingFooter />
    </div>
  );
}

function LandingNav(): React.JSX.Element {
  return (
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
  );
}

function Hero(): React.JSX.Element {
  return (
    <section className="landing__hero" aria-labelledby="hero-title">
      <div className="landing__hero-copy">
        <p className="landing__eyebrow">{LANDING.hero.eyebrow}</p>
        <h1 id="hero-title" className="landing__headline">
          {BRAND.tagline}
        </h1>
        <p className="landing__sub">{LANDING.hero.sub}</p>
        <div className="landing__cta-row">
          <Link href="/signup" className="btn btn--primary landing__cta">
            {LANDING.hero.ctaPrimary}
          </Link>
          <Link href="/login" className="btn landing__cta landing__cta--ghost">
            {LANDING.hero.ctaSecondary}
          </Link>
        </div>
      </div>
      <div className="landing__hero-stage">
        <PopMark burst className="landing__popmark" />
        <HeroVignette />
      </div>
    </section>
  );
}

function HowItWorks(): React.JSX.Element {
  return (
    <section className="landing__section landing__how" aria-labelledby="how-title">
      <h2 id="how-title" className="landing__section-title">
        {LANDING.sections.howTitle}
      </h2>
      <p className="landing__section-sub">{LANDING.sections.howSub}</p>
      <ol className="landing__steps">
        {LANDING.steps.map((step) => (
          <li key={step.n} className="landing__step">
            <span className="landing__step-n" aria-hidden="true">
              {step.n}
            </span>
            <h3 className="landing__step-title">{step.title}</h3>
            <p className="landing__step-body">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Department(): React.JSX.Element {
  return (
    <section className="landing__section landing__dept" aria-labelledby="dept-title">
      <h2 id="dept-title" className="landing__section-title">
        {LANDING.sections.fleetTitle}
      </h2>
      <p className="landing__section-sub">{LANDING.sections.fleetSub}</p>
      <ul className="landing__roster">
        {FLEET.map((agent) => {
          const color = agentColor(agent.name) ?? BRAND.accent;
          return (
            <li
              key={agent.handle}
              className="landing__agent"
              style={{ ["--agent-hue" as string]: color }}
            >
              <PopMark color={color} size={30} className="landing__agent-mark" />
              <h3 className="landing__agent-name">{agent.name}</h3>
              <p className="landing__agent-handle" style={{ color }}>
                @{agent.handle}
              </p>
              <p className="landing__agent-personality">{agent.personality}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PricingTeaser(): React.JSX.Element {
  return (
    <section className="landing__section landing__pricing" aria-labelledby="pricing-title">
      <h2 id="pricing-title" className="landing__section-title">
        {LANDING.sections.pricingTitle}
      </h2>
      <p className="landing__section-sub">{LANDING.sections.pricingSub}</p>
      <ul className="landing__plans">
        {LANDING.plans.map((plan) => (
          <li
            key={plan.name}
            className={`landing__plan${plan.featured ? " landing__plan--featured" : ""}`}
          >
            {plan.featured && <span className="landing__plan-ribbon">Most popular</span>}
            <h3 className="landing__plan-name">{plan.name}</h3>
            <p className="landing__plan-price">
              <span className="landing__plan-amount">{plan.price}</span>
              <span className="landing__plan-period">/mo</span>
            </p>
            <p className="landing__plan-tagline">{plan.tagline}</p>
          </li>
        ))}
      </ul>
      <Link href="/signup" className="linklike landing__pricing-link">
        {LANDING.sections.pricingCta} →
      </Link>
    </section>
  );
}

function ClosingCta(): React.JSX.Element {
  return (
    <section className="landing__section landing__final" aria-labelledby="final-title">
      <h2 id="final-title" className="landing__final-title">
        {LANDING.sections.ctaTitle}
      </h2>
      <p className="landing__final-sub">{LANDING.sections.ctaSub}</p>
      <Link href="/signup" className="btn btn--primary landing__cta landing__final-cta">
        {LANDING.sections.ctaButton}
      </Link>
    </section>
  );
}

function LandingFooter(): React.JSX.Element {
  return (
    <footer className="landing__footer">
      <Wordmark className="landing__footer-mark" />
      <p className="landing__signoff">{VOICE.signOff}</p>
    </footer>
  );
}
