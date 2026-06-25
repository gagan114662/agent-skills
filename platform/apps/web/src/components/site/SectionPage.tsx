/**
 * The generic content page for the marketing site (#153): one component serves a section index
 * (`/compare`, `/stories`, `/guides`, `/changelog`) and a single document (`/compare/vs-diy`). Content
 * comes from the public `/site/*` API (published repo markdown), rendered as typed blocks. Loading,
 * empty, and offline states all keep the house voice instead of crashing.
 */
import { useEffect, useState } from "react";
import type { SiteDocDetail, SiteDocMeta } from "../../api/types.js";
import { api } from "../../api/client.js";
import { SITE, STORIES } from "../../brand.js";
import { Link } from "../../routing.js";
import { Markdown } from "./Markdown.js";

export interface SectionCopy {
  eyebrow: string;
  title: string;
  sub: string;
}

type LoadState<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error" } | { status: "missing" };

export function SectionPage({
  section,
  slug,
  copy,
}: {
  section: string;
  slug?: string;
  copy: SectionCopy;
}): React.JSX.Element {
  return slug ? <DocView section={section} slug={slug} /> : <IndexView section={section} copy={copy} />;
}

function IndexView({ section, copy }: { section: string; copy: SectionCopy }): React.JSX.Element {
  const [state, setState] = useState<LoadState<SiteDocMeta[]>>({ status: "loading" });
  const isStories = section === "stories";

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    api.site
      .section(section)
      .then((docs) => live && setState({ status: "ready", data: docs }))
      .catch(() => live && setState({ status: "error" }));
    return () => {
      live = false;
    };
  }, [section]);

  return (
    <article className="site-page">
      <header className="site-page__head">
        <p className="site-page__eyebrow">{copy.eyebrow}</p>
        <h1 className="site-page__title">{copy.title}</h1>
        <p className="site-page__sub">{copy.sub}</p>
      </header>
      {isStories && <StoryProofList />}
      {state.status === "loading" && !isStories && <p className="site-page__note">…</p>}
      {state.status === "error" && !isStories && <p className="site-page__note">{SITE.offline}</p>}
      {state.status === "ready" && state.data.length === 0 && !isStories && <p className="site-page__note">{SITE.empty}</p>}
      {state.status === "ready" && state.data.length > 0 && (
        <ul className="site-cards">
          {state.data.map((doc) => (
            <li key={doc.slug} className="site-card">
              <Link href={`/${section}/${doc.slug}`} className="site-card__link">
                <h2 className="site-card__title">{doc.title}</h2>
                <p className="site-card__desc">{doc.description}</p>
                <p className="site-card__by">by {doc.agent}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function StoryProofList(): React.JSX.Element {
  return (
    <section className="site-cards" aria-label="Receipt-backed stories">
      {STORIES.proof.map((story) => (
        <article key={story.id} className="site-card" aria-label={story.customer}>
          <h2 className="site-card__title">{story.customer}</h2>
          <p className="site-card__by">
            {story.date} · {story.consented ? "consented receipt" : "external proof pending"}
          </p>
          <p className="site-card__desc">{story.context}</p>
          <p className="site-card__desc">
            <strong>Starting problem:</strong> {story.problem}
          </p>
          <p className="site-card__desc">
            <strong>What the fleet did:</strong> {story.work}
          </p>
          <p className="site-card__desc">
            <strong>Receipt/source:</strong> {story.receipt}
          </p>
          <p className="site-card__desc">
            <strong>Approval/consent:</strong> {story.consentStatus}
          </p>
          <p className="site-card__desc">
            <strong>Outcome:</strong> {story.result}
          </p>
          {story.artifacts.length > 0 && (
            <p className="site-card__desc">
              <strong>Artifacts:</strong>{" "}
              {story.artifacts.map((artifact, index) => (
                <span key={artifact.href}>
                  {index > 0 ? ", " : ""}
                  <Link href={artifact.href} className="linklike">
                    {artifact.label}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}

function DocView({ section, slug }: { section: string; slug: string }): React.JSX.Element {
  const [state, setState] = useState<LoadState<SiteDocDetail>>({ status: "loading" });

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    api.site
      .doc(section, slug)
      .then((doc) => live && setState(doc ? { status: "ready", data: doc } : { status: "missing" }))
      .catch(() => live && setState({ status: "error" }));
    return () => {
      live = false;
    };
  }, [section, slug]);

  return (
    <article className="site-doc">
      <Link href={`/${section}`} className="linklike site-doc__back">
        {SITE.backToSite}
      </Link>
      {state.status === "loading" && <p className="site-page__note">…</p>}
      {state.status === "error" && <p className="site-page__note">{SITE.offline}</p>}
      {state.status === "missing" && <p className="site-page__note">{SITE.empty}</p>}
      {state.status === "ready" && (
        <>
          <header className="site-doc__head">
            <h1 className="site-doc__title">{state.data.title}</h1>
            <p className="site-doc__meta">
              by {state.data.agent}
              {state.data.date ? ` · ${state.data.date}` : ""}
            </p>
          </header>
          <Markdown blocks={state.data.blocks} />
        </>
      )}
    </article>
  );
}
