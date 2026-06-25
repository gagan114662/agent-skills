import type { SegmentLandingPage as SegmentLandingPageCopy } from "../../brand.js";
import { Link } from "../../routing.js";

export function SegmentLandingPage({ page }: { page: SegmentLandingPageCopy }): React.JSX.Element {
  return (
    <article className="segment-page" data-experiment={page.experiment.id}>
      <header className="segment-page__hero">
        <p className="site-page__eyebrow">{page.hero.eyebrow}</p>
        <h1 className="segment-page__title">{page.hero.title}</h1>
        <p className="segment-page__sub">{page.hero.sub}</p>
        <div className="segment-page__actions">
          <Link href={page.cta.href} className="btn btn--primary">
            {page.cta.label}
          </Link>
        </div>
      </header>

      <section className="segment-page__proof" aria-labelledby={page.slug + "-proof"}>
        <p className="segment-page__metric">{page.proof.metric}</p>
        <div>
          <h2 id={page.slug + "-proof"} className="segment-page__proof-title">
            {page.proof.title}
          </h2>
          <p className="segment-page__proof-body">{page.proof.body}</p>
        </div>
      </section>

      <ul className="segment-page__bullets">
        {page.bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>

      <section className="segment-page__experiment" aria-label={page.experiment.id}>
        {page.experiment.variants.map((variant) => (
          <Link key={variant.key} href={variant.href} className="segment-page__variant">
            <span>{variant.key.toUpperCase()}</span>
            {variant.label}
          </Link>
        ))}
      </section>
    </article>
  );
}
