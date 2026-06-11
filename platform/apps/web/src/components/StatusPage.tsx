/**
 * The PUBLIC status page (#148) — rendered BEFORE the AuthGate (no session, no store). It reads the
 * slug from the URL and fetches the unauthenticated `/status/:slug` endpoint, which 404s unless the
 * workspace opted in. Component health + a redacted incident history, auto-refreshing while open.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import type { StatusLevel, StatusPageDto } from "../api/types.js";

const OVERALL_LABEL: Record<StatusLevel, string> = {
  operational: "All systems operational",
  degraded: "Degraded performance",
  major_outage: "Major outage",
};

const DOT: Record<StatusLevel, string> = {
  operational: "🟢",
  degraded: "🟠",
  major_outage: "🔴",
};

const REFRESH_MS = 30_000;

export function StatusPage({ slug }: { slug: string }): React.JSX.Element {
  const [page, setPage] = useState<StatusPageDto | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Tracks whether we ever loaded — so a later auto-refresh failure doesn't flip a live page to
  // "not found" (only the FIRST load failing means the page isn't published). A ref, not state, so
  // the polling closure always reads the latest value without re-subscribing the interval.
  const loadedRef = useRef(false);

  useEffect(() => {
    let live = true;
    loadedRef.current = false;
    const load = (): void => {
      void api
        .getStatusPage(slug)
        .then((data) => {
          if (!live) return;
          loadedRef.current = true;
          setPage(data);
          setNotFound(false);
        })
        .catch(() => {
          if (live && !loadedRef.current) setNotFound(true);
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [slug]);

  if (notFound) {
    return (
      <div className="status status--empty">
        <h1>No status page</h1>
        <p>This workspace has not published a status page.</p>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="status status--loading">
        <p>Loading status…</p>
      </div>
    );
  }

  return (
    <div className={`status status--${page.overall}`}>
      <header className="status__head">
        <h1>{page.workspaceName} status</h1>
        <p className={`status__overall status__overall--${page.overall}`}>
          {DOT[page.overall]} {OVERALL_LABEL[page.overall]}
        </p>
      </header>

      <section className="status__components" aria-label="Component health">
        <h2>Components</h2>
        <ul>
          {page.components.map((c) => (
            <li key={c.name} className={`status__component status__component--${c.status}`}>
              <span className="status__component-dot">{DOT[c.status]}</span>
              <span className="status__component-name">{c.name}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="status__incidents" aria-label="Incident history">
        <h2>Incident history</h2>
        {page.incidents.length === 0 ? (
          <p className="status__none">No incidents reported.</p>
        ) : (
          <ul>
            {page.incidents.map((i, idx) => (
              <li key={idx} className={`status__incident status__incident--${i.status}`}>
                <span className="status__incident-title">{i.title}</span>
                <span className="status__incident-status">{i.status}</span>
                <time dateTime={i.openedAt}>{new Date(i.openedAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="status__foot">
        <time dateTime={page.generatedAt}>Updated {new Date(page.generatedAt).toLocaleString()}</time>
      </footer>
    </div>
  );
}
