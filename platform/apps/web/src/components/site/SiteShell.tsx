/**
 * The shared chrome for every marketing-site page (#153): the top nav, the page body, and the footer
 * that carries the dogfood credit ("maintained by Quill") and the Ask-AI deep links (the GEO play).
 * Every word comes from `brand.ts` so the site components carry no hardcoded brand strings (brand.test
 * scans this directory). The site is public — these pages render for logged-out *and* logged-in visitors.
 */
import { BRAND, SITE, ASK_AI, VOICE, askAiLinks } from "../../brand.js";
import { Link, useRoute } from "../../routing.js";
import { Wordmark } from "../Wordmark.js";
import { PopMark } from "../PopMark.js";

export function SiteShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const path = useRoute();
  return (
    <div className="site">
      <header className="site__nav">
        <Link href="/" className="site__brand" aria-label={BRAND.name}>
          <Wordmark />
        </Link>
        <nav className="site__nav-links" aria-label="Marketing site">
          {SITE.nav.map((item) => {
            const active = path === item.href || path.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`site__nav-link${active ? " site__nav-link--active" : ""}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="site__nav-actions">
          <Link href="/login" className="linklike">
            {SITE.ctaSecondary}
          </Link>
          <Link href="/signup" className="btn btn--primary site__nav-cta">
            {SITE.ctaPrimary}
          </Link>
        </div>
      </header>

      <main className="site__main">{children}</main>

      <SiteFooter />
    </div>
  );
}

function SiteFooter(): React.JSX.Element {
  const links = askAiLinks();
  return (
    <footer className="site__footer">
      <div className="site__ask-ai">
        <h3 className="site__ask-ai-title">{ASK_AI.heading}</h3>
        <p className="site__ask-ai-blurb">{ASK_AI.blurb}</p>
        <div className="site__ask-ai-links">
          {links.map((link) => (
            <a
              key={link.key}
              className="btn site__ask-ai-link"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.label} ↗
            </a>
          ))}
        </div>
      </div>
      <div className="site__footer-base">
        <PopMark className="site__footer-mark" />
        <p className="site__credit">{SITE.maintainedBy}</p>
        <a href={SITE.support.href} className="site__support-link">
          {SITE.support.label}
        </a>
        <p className="site__signoff">{VOICE.signOff}</p>
      </div>
    </footer>
  );
}
