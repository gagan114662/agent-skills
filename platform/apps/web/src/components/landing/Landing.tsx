/**
 * The public marketing homepage (#149 → #165) — and the website *is* the product. A logged-out visitor
 * at `/` doesn't get a brochure with a screenshot; they get a faithful, auto-playing simulation of the
 * ipop console itself: the full sidebar, a whole day's agent timeline with task cards, QA results, and a
 * human approval, then numbered story sections each paired with a true slice of the app (mission control,
 * the approvals drawer, the decision log), pricing rendered as the in-app billing screen, a substantive
 * FAQ, and a short human contact form.
 *
 * Strictly per the committed brand book (docs/brand/ipop-brand-identity.html): Paper/Ink/Vermilion, the
 * popped-i wordmark, department-spectrum colours, the pop easing on every move — all gated behind
 * prefers-reduced-motion. Every word comes from `brand.ts` so there are no hardcoded brand strings
 * (brand.test scans this directory). The console lives behind auth; this is the storefront.
 */
import { useEffect } from "react";
import {
  BRAND,
  FLEET,
  LANDING,
  SECURITY,
  STORY,
  VOICE,
  agentColor,
  type StorySection,
} from "../../brand.js";
import { I18N, currentLocale, type LandingCopy } from "../../i18n.js";
import { Link } from "../../routing.js";
import { Wordmark } from "../Wordmark.js";
import { PopMark } from "../PopMark.js";
import { WorkspaceSim } from "./WorkspaceSim.js";
import { BillingScreen } from "./BillingScreen.js";
import { Faq } from "./Faq.js";
import { ContactForm } from "./ContactForm.js";
import {
  ApprovalsDrawer,
  DepartmentChips,
  MemoryLedger,
  MissionControl,
} from "./Vignettes.js";

export function Landing(): React.JSX.Element {
  const locale = currentLocale();
  const { landing } = I18N[locale];
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <div className="landing" lang={locale}>
      <LandingNav landing={landing} />
      <main>
        <Hero landing={landing} />
        <StorySections />
        <HowItWorks landing={landing} />
        <Department landing={landing} />
        <Pricing landing={landing} />
        <Faq />
        <ContactForm />
        <ClosingCta landing={landing} />
      </main>
      <LandingFooter />
    </div>
  );
}

function LandingNav({ landing }: { landing: LandingCopy }): React.JSX.Element {
  const locale = currentLocale();
  const copy = I18N[locale];
  return (
    <header className="landing__nav">
      <Link href="/" className="landing__brand" aria-label={BRAND.name}>
        <Wordmark />
      </Link>
      <details className="landing__mobile-nav">
        <summary aria-label={copy.navToggle} className="landing__mobile-nav-toggle">
          <span aria-hidden="true"></span>
        </summary>
        <nav className="landing__mobile-nav-links" aria-label={copy.navLabel}>
          {landing.anchors.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="linklike landing__nav-link"
              onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </details>
      <nav className="landing__nav-links" aria-label={copy.navLabel}>
        {landing.anchors.map((item) => (
          <a key={item.href} href={item.href} className="linklike landing__nav-link">
            {item.label}
          </a>
        ))}
      </nav>
      <nav className="landing__nav-actions">
        <Link href="/login" className="linklike">
          {landing.hero.ctaSecondary}
        </Link>
        <Link href="/start" className="btn btn--primary landing__nav-cta">
          {landing.hero.ctaPrimary}
        </Link>
      </nav>
    </header>
  );
}

function Hero({ landing }: { landing: LandingCopy }): React.JSX.Element {
  return (
    <section className="landing__hero" aria-labelledby="hero-title">
      <div className="landing__hero-copy">
        <p className="landing__eyebrow">{landing.hero.eyebrow}</p>
        <h1 id="hero-title" className="landing__headline">
          {BRAND.tagline}
        </h1>
        <p className="landing__sub">{landing.hero.sub}</p>
        <div className="landing__cta-row">
          <Link href="/start" className="btn btn--primary landing__cta">
            {landing.hero.ctaPrimary}
          </Link>
          <Link href="/login" className="btn landing__cta landing__cta--ghost">
            {landing.hero.ctaSecondary}
          </Link>
        </div>
      </div>
      <div className="landing__hero-stage">
        <PopMark burst className="landing__popmark" />
        <WorkspaceSim />
      </div>
    </section>
  );
}

function HowItWorks({ landing }: { landing: LandingCopy }): React.JSX.Element {
  return (
    <section id="how" className="landing__section landing__how" aria-labelledby="how-title">
      <h2 id="how-title" className="landing__section-title">
        {landing.sections.howTitle}
      </h2>
      <p className="landing__section-sub">{landing.sections.howSub}</p>
      <ol className="landing__steps">
        {landing.steps.map((step) => (
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

/** The four numbered story sections (01–04), each paired with a product-true visual, alternating sides. */
function StorySections(): React.JSX.Element {
  return (
    <section className="landing__section landing__stories">
      {STORY.map((story, i) => (
        <article
          key={story.n}
          className={`landing__story${i % 2 === 1 ? " landing__story--flip" : ""}`}
        >
          <div className="landing__story-copy">
            <span className="landing__story-n" aria-hidden="true">
              {story.n}
            </span>
            <h3 className="landing__story-title">{story.title}</h3>
            <p className="landing__story-body">{story.body}</p>
          </div>
          <div className="landing__story-visual">
            <StoryVisual visual={story.visual} />
          </div>
        </article>
      ))}
    </section>
  );
}

function StoryVisual({ visual }: { visual: StorySection["visual"] }): React.JSX.Element {
  switch (visual) {
    case "department":
      return <DepartmentChips />;
    case "mission":
      return <MissionControl />;
    case "approvals":
      return <ApprovalsDrawer />;
    case "memory":
      return <MemoryLedger />;
  }
}

function Department({ landing }: { landing: LandingCopy }): React.JSX.Element {
  return (
    <section id="agents" className="landing__section landing__dept" aria-labelledby="dept-title">
      <h2 id="dept-title" className="landing__section-title">
        {landing.sections.fleetTitle}
      </h2>
      <p className="landing__section-sub">{landing.sections.fleetSub}</p>
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

function Pricing({ landing }: { landing: LandingCopy }): React.JSX.Element {
  return (
    <section id="pricing" className="landing__section landing__pricing" aria-labelledby="pricing-title">
      <h2 id="pricing-title" className="landing__section-title">
        {landing.sections.pricingTitle}
      </h2>
      <p className="landing__section-sub">{landing.sections.pricingSub}</p>
      <BillingScreen />
      <Link href="/pricing" className="linklike landing__pricing-link">
        {landing.sections.pricingCta} →
      </Link>
    </section>
  );
}

function ClosingCta({ landing }: { landing: LandingCopy }): React.JSX.Element {
  return (
    <section className="landing__section landing__final" aria-labelledby="final-title">
      <h2 id="final-title" className="landing__final-title">
        {landing.sections.ctaTitle}
      </h2>
      <p className="landing__final-sub">{landing.sections.ctaSub}</p>
      <Link href="/start" className="btn btn--primary landing__cta landing__final-cta">
        {landing.sections.ctaButton}
      </Link>
    </section>
  );
}

function LandingFooter(): React.JSX.Element {
  const { footer } = LANDING;
  return (
    <footer className="landing__footer">
      <div className="landing__footer-top">
        <div className="landing__footer-brand">
          <Wordmark className="landing__footer-mark" />
          <p className="landing__signoff">{VOICE.signOff}</p>
        </div>
        <div className="landing__footer-cols">
          <FooterCol title={footer.productTitle} links={footer.product} />
          <FooterCol title={footer.resourcesTitle} links={footer.resources} />
          <nav className="landing__footer-col" aria-label={footer.socialTitle}>
            <p className="landing__footer-col-title">{footer.socialTitle}</p>
            {footer.social.map((s) => (
              <Link key={s.key} href={s.href} className="linklike landing__footer-link">
                {s.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
      <div className="landing__footer-bottom">
        <Link href="/security" className="linklike landing__footer-link">
          {SECURITY.navLabel}
        </Link>
      </div>
    </footer>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: readonly { href: string; label: string }[];
}): React.JSX.Element {
  return (
    <nav className="landing__footer-col" aria-label={title}>
      <p className="landing__footer-col-title">{title}</p>
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="linklike landing__footer-link">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
