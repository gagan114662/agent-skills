/**
 * Public company-level legal pages (#863). These are static, unauthenticated product pages, separate from
 * the workspace-scoped generated legal docs in the backend.
 */
import { BRAND, LEGAL } from "../../brand.js";
import { Link } from "../../routing.js";
import { Wordmark } from "../Wordmark.js";

export type LegalPageKind = "terms" | "privacy";

export function LegalPage({ kind }: { kind: LegalPageKind }): React.JSX.Element {
  const copy = LEGAL[kind];
  return (
    <div className="landing landing--security">
      <header className="landing__nav">
        <Link href="/" className="landing__brand" aria-label={BRAND.name}>
          <Wordmark />
        </Link>
        <nav className="landing__nav-actions">
          <Link href="/security" className="linklike">
            {LEGAL.securityCta}
          </Link>
          <Link href="/" className="btn btn--primary landing__nav-cta">
            {LEGAL.backCta}
          </Link>
        </nav>
      </header>

      <main>
        <section className="landing__hero landing__security-hero" aria-labelledby={`${kind}-title`}>
          <div className="landing__hero-copy">
            <p className="landing__eyebrow">{copy.eyebrow}</p>
            <h1 id={`${kind}-title`} className="landing__headline">
              {copy.title}
            </h1>
            <p className="landing__sub">{copy.sub}</p>
            <p className="landing__section-sub legal-page__updated">{copy.updated}</p>
          </div>
        </section>

        <section className="landing__section" aria-labelledby={`${kind}-sections`}>
          <h2 id={`${kind}-sections`} className="landing__section-title">
            {copy.navLabel}
          </h2>
          <ul className="landing__guarantees">
            {copy.sections.map((section) => (
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
          <Link href={LEGAL.terms.href} className="linklike landing__footer-link">
            {LEGAL.terms.navLabel}
          </Link>
          <Link href={LEGAL.privacy.href} className="linklike landing__footer-link">
            {LEGAL.privacy.navLabel}
          </Link>
          <Wordmark className="landing__footer-mark" />
        </div>
      </footer>
    </div>
  );
}
