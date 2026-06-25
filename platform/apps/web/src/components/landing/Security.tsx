/**
 * The public trust page (#151) — `/security`, reachable by anyone. Honest by construction: the
 * "guarantees" grid lists only mechanisms the platform actually enforces in code today (approval gates,
 * tenant isolation, kill switch, budget caps, audit trail, scoped credentials, egress allowlists, roles);
 * the "roadmap" grid lists things NOT yet built or certified (SOC 2, GDPR DPA, SSO), each carrying an
 * explicit status so nothing reads as a claim; and a closing note states plainly that we hold no
 * third-party certifications. All copy comes from `brand.ts` (SECURITY) — brand.test scans this directory.
 */
import { BRAND, SECURITY } from "../../brand.js";
import { Link } from "../../routing.js";
import { Wordmark } from "../Wordmark.js";

export function Security(): React.JSX.Element {
  return (
    <div className="landing landing--security">
      <header className="landing__nav">
        <Link href="/" className="landing__brand" aria-label={BRAND.name}>
          <Wordmark />
        </Link>
        <nav className="landing__nav-actions">
          <Link href="/" className="linklike">
            {SECURITY.backCta}
          </Link>
        </nav>
      </header>

      <main>
        <section className="landing__hero landing__security-hero" aria-labelledby="security-title">
          <div className="landing__hero-copy">
            <p className="landing__eyebrow">{SECURITY.eyebrow}</p>
            <h1 id="security-title" className="landing__headline">
              {SECURITY.title}
            </h1>
            <p className="landing__sub">{SECURITY.sub}</p>
          </div>
        </section>

        <section
          className="landing__section landing__security-built"
          aria-labelledby="guarantees-title"
        >
          <h2 id="guarantees-title" className="landing__section-title">
            {SECURITY.guaranteesTitle}
          </h2>
          <ul className="landing__guarantees">
            {SECURITY.guarantees.map((g) => (
              <li key={g.title} className="landing__guarantee">
                <h3 className="landing__guarantee-title">{g.title}</h3>
                <p className="landing__guarantee-body">{g.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section
          className="landing__section landing__security-roadmap"
          aria-labelledby="roadmap-title"
        >
          <h2 id="roadmap-title" className="landing__section-title">
            {SECURITY.roadmapTitle}
          </h2>
          <ul className="landing__roadmap">
            {SECURITY.roadmap.map((r) => (
              <li key={r.title} className="landing__roadmap-item">
                <div className="landing__roadmap-head">
                  <h3 className="landing__roadmap-name">{r.title}</h3>
                  <span className="landing__roadmap-status">{r.status}</span>
                </div>
                <p className="landing__roadmap-body">{r.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing__section" aria-labelledby="sla-title">
          <h2 id="sla-title" className="landing__section-title">
            {SECURITY.slaTitle}
          </h2>
          <p className="landing__section-sub landing__security-disclaimer">{SECURITY.sla}</p>
        </section>

        <section
          className="landing__section landing__security-honest"
          aria-labelledby="notclaimed-title"
        >
          <h2 id="notclaimed-title" className="landing__section-title">
            {SECURITY.notClaimedTitle}
          </h2>
          <p className="landing__section-sub landing__security-disclaimer">{SECURITY.notClaimed}</p>
          <Link href="/" className="btn landing__cta landing__cta--ghost">
            {SECURITY.backCta}
          </Link>
        </section>
      </main>

      <footer className="landing__footer">
        <Wordmark className="landing__footer-mark" />
      </footer>
    </div>
  );
}
