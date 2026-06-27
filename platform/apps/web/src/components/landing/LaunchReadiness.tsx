/**
 * Public launch-readiness readout (#1293) with the Codex operator lane (#1265) and pricing limits (#1290).
 * Every word comes from brand.ts so the page has one truthful source for proof states and pricing claims.
 */
import { LAUNCH_READINESS } from "../../brand.js";

export function LaunchReadiness(): React.JSX.Element {
  return (
    <section className="launch-readiness landing__section" aria-labelledby="launch-readiness-title">
      <div className="launch-readiness__intro">
        <p className="landing__eyebrow">{LAUNCH_READINESS.eyebrow}</p>
        <h2 id="launch-readiness-title" className="landing__section-title">
          {LAUNCH_READINESS.title}
        </h2>
        <p className="landing__section-sub">{LAUNCH_READINESS.sub}</p>
      </div>

      <div className="launch-readiness__grid">
        <article className="launch-card launch-card--pricing">
          <h3 className="launch-card__title">{LAUNCH_READINESS.pricing.title}</h3>
          <p className="launch-card__body">{LAUNCH_READINESS.pricing.body}</p>
          <ul className="launch-card__list">
            {LAUNCH_READINESS.pricing.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </article>

        <article className="launch-card launch-card--codex">
          <p className="launch-card__kicker">{LAUNCH_READINESS.codex.status}</p>
          <h3 className="launch-card__title">{LAUNCH_READINESS.codex.title}</h3>
          <p className="launch-card__body">{LAUNCH_READINESS.codex.body}</p>
        </article>
      </div>

      <div className="launch-readiness__proof" aria-label={LAUNCH_READINESS.proofLabel}>
        {LAUNCH_READINESS.proof.map((item) => (
          <article key={item.label} className="proof-chip">
            <h3 className="proof-chip__label">{item.label}</h3>
            <p>{item.body}</p>
          </article>
        ))}
      </div>

      <div className="launch-checklist">
        <h3 className="launch-checklist__title">{LAUNCH_READINESS.checklistTitle}</h3>
        <ul className="launch-checklist__rows">
          {LAUNCH_READINESS.checklist.map((item) => (
            <li key={item.area} className="launch-checklist__row">
              <span className={"launch-checklist__state launch-checklist__state--" + item.state.toLowerCase()}>
                {item.state}
              </span>
              <span className="launch-checklist__area">{item.area}</span>
              <span className="launch-checklist__detail">{item.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
