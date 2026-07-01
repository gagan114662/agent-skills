/**
 * Public company information (#866). The component is structural only; legal facts and labels live in
 * brand.ts so deployment-specific entity details can be overridden without changing chrome code.
 */
import { COMPANY } from "../../brand.js";
import { Link } from "../../routing.js";
import { PublicDoorNav } from "../onboarding/PublicDoorNav.js";
import { TELEGRAM_BOT_URL } from "../onboarding/messaging-entry.js";
import { Wordmark } from "../Wordmark.js";

export function CompanyPage(): React.JSX.Element {
  return (
    <div className="landing landing--security">
      <PublicDoorNav className="landing__nav" startHref={TELEGRAM_BOT_URL} />

      <main>
        <section className="landing__hero landing__security-hero" aria-labelledby="company-title">
          <div className="landing__hero-copy">
            <p className="landing__eyebrow">{COMPANY.eyebrow}</p>
            <h1 id="company-title" className="landing__headline">
              {COMPANY.title}
            </h1>
            <p className="landing__sub">{COMPANY.sub}</p>
            <p className="landing__section-sub legal-page__updated">{COMPANY.updated}</p>
          </div>
        </section>

        <section className="landing__section" aria-labelledby="company-details">
          <h2 id="company-details" className="landing__section-title">
            {COMPANY.factsTitle}
          </h2>
          <ul className="landing__guarantees">
            {COMPANY.details.map((detail) => (
              <li key={detail.label} className="landing__guarantee">
                <h3 className="landing__guarantee-title">{detail.label}</h3>
                <p className="landing__guarantee-body">{detail.value}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing__section" aria-labelledby="company-notes">
          <h2 id="company-notes" className="landing__section-title">
            {COMPANY.navLabel}
          </h2>
          <ul className="landing__guarantees">
            {COMPANY.sections.map((section) => (
              <li key={section.title} className="landing__guarantee">
                <h3 className="landing__guarantee-title">{section.title}</h3>
                <p className="landing__guarantee-body">{section.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="landing__footer">
        <div className="landing__footer-bottom">
          {COMPANY.legalLinks.map((link) => (
            <Link key={link.href} href={link.href} className="linklike landing__footer-link">
              {link.label}
            </Link>
          ))}
          <Wordmark className="landing__footer-mark" />
        </div>
      </footer>
    </div>
  );
}
