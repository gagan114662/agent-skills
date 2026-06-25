import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client.js";
import type { PublicDogfoodFeedDto, PublicDogfoodPhase } from "../../api/types.js";

const PHASE_LABEL: Record<PublicDogfoodPhase, string> = {
  thinking: "Thinking",
  tool: "Tool",
  artifact: "Artifact",
  approval: "Approval",
  outcome: "Outcome",
  blocked: "Blocked",
};

const REFRESH_MS = 30_000;

export function PublicDogfood({ slug = "ipop" }: { slug?: string }): React.JSX.Element {
  const [feed, setFeed] = useState<PublicDogfoodFeedDto | null>(null);
  const [notFound, setNotFound] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    let live = true;
    loadedRef.current = false;
    const load = (): void => {
      void api
        .getPublicDogfoodFeed(slug)
        .then((data) => {
          if (!live) return;
          loadedRef.current = true;
          setFeed(data);
          setNotFound(false);
        })
        .catch((err) => {
          if (live && !loadedRef.current) setNotFound(err instanceof ApiError && err.status === 404);
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
      <main className="dogfood dogfood--empty">
        <p className="dogfood__eyebrow">Dogfood feed</p>
        <h1>No public dogfood feed</h1>
        <p>This workspace has not published public dogfood receipts.</p>
      </main>
    );
  }

  if (!feed) {
    return (
      <main className="dogfood dogfood--loading">
        <p>Loading dogfood receipts...</p>
      </main>
    );
  }

  return (
    <main className="dogfood">
      <header className="dogfood__head">
        <p className="dogfood__eyebrow">Built with ipop</p>
        <h1>{feed.title}</h1>
        <p>
          Real work receipts from {feed.workspaceName}. No public receipt appears here unless a run
          produced trace-backed work and passed the public redaction layer.
        </p>
        {feed.lastUpdatedAt ? (
          <time dateTime={feed.lastUpdatedAt}>Updated {new Date(feed.lastUpdatedAt).toLocaleString()}</time>
        ) : null}
      </header>

      {feed.receipts.length === 0 ? (
        <section className="dogfood__empty" aria-label="Empty dogfood feed">
          <h2>No public dogfood receipts yet</h2>
          <p>The fleet has not published any public receipts for this workspace.</p>
        </section>
      ) : (
        <ol className="dogfood__receipts" aria-label="Dogfood receipts">
          {feed.receipts.map((receipt) => (
            <li key={receipt.id} className={"dogfood__receipt dogfood__receipt--" + receipt.phase}>
              <div className="dogfood__receipt-top">
                <span className="dogfood__phase">{PHASE_LABEL[receipt.phase]}</span>
                <time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time>
              </div>
              <h2>{receipt.workstream}</h2>
              <p>{receipt.summary}</p>
              <dl>
                <div>
                  <dt>Agent</dt>
                  <dd>{receipt.agent}</dd>
                </div>
                {receipt.artifactLabel ? (
                  <div>
                    <dt>Artifact</dt>
                    <dd>{receipt.artifactLabel}</dd>
                  </div>
                ) : null}
                {receipt.approvalStatus ? (
                  <div>
                    <dt>Approval</dt>
                    <dd>{receipt.approvalStatus}</dd>
                  </div>
                ) : null}
              </dl>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
