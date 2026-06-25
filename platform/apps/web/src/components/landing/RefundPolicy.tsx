/**
 * Public refund + support SLA page (#865). Copy lives in brand.ts so the page stays structural and the
 * policy can be linked from pricing, security, and the footer without duplicating terms.
 */
import { BRAND, REFUND_POLICY } from "../../brand.js";
import { Link } from "../../routing.js";
import { Wordmark } from "../Wordmark.js";

export function RefundPolicy(): React.JSX.Element {
  return (
    <div className="landing landing--security">
      <header className="landing__nav">
        <Link href="/" className="landing__brand" aria-label={BRAND.name}>
          <Wordmark />
        </Link>
        <nav className="landing__nav-actions">
          <Link href={REFUND_POLICY.securityHref} className="linklike">
            {REFUND_POLICY.securityCta}
          </Link>
          <Link href={REFUND_POLICY.ctaHref} className="btn btn--primary landing__nav-cta">
            {REFUND_POLICY.cta}
          </Link>
        </nav>
      </header>

      <main>
        <section className="landing__hero landing__security-hero" aria-labelledby="refund-policy-title">
          <div className="landing__hero-copy">
            <p className="landing__eyebrow">{REFUND_POLICY.eyebrow}</p>
            <h1 id="refund-policy-title" className="landing__headline">
              {REFUND_POLICY.title}
            </h1>
            <p className="landing__sub">{REFUND_POLICY.sub}</p>
          </div>
        </section>

        <section className="landing__section" aria-labelledby="refund-policy-terms">
          <h2 id="refund-policy-terms" className="landing__section-title">
            {REFUND_POLICY.navLabel}
          </h2>
          <ul className="landing__guarantees">
            {REFUND_POLICY.sections.map((section) => (
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
          <Link href={REFUND_POLICY.ctaHref} className="linklike landing__footer-link">
            {REFUND_POLICY.cta}
          </Link>
          <Wordmark className="landing__footer-mark" />
        </div>
      </footer>
    </div>
  );
}
