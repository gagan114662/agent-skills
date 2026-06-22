/**
 * #633 outcome-first onboarding — the live deliverable view.
 *
 * The moment a visitor types their website and asks to see it, we open the public SSE stream and render a
 * real, personalized artifact about their business as it arrives, section by section. The Google sign-in
 * (the only "config") sits *alongside* the streaming artifact, never in front of it: the visitor watches a
 * deliverable appear with zero setup, and signs in when (and if) they like what they see.
 *
 * The stream is injectable (`eventSourceFactory`) so this renders under jsdom in tests with a fake source.
 * If the stream can't start we degrade honestly to an error line + the sign-in path (#200 §3: no faked
 * artifact). Everything streamed is server-sanitized text rendered as React children — never raw markup.
 */
import { useEffect, useRef, useState } from "react";
import { ONBOARDING } from "../brand.js";
import {
  openDeliverableStream,
  type DeliverableSectionDto,
  type DeliverableStartDto,
  type DeliverableStreamHandle,
  type EventSourceLike,
} from "../api/deliverable.js";
import { PopMark } from "./PopMark.js";

export interface DeliverablePreviewProps {
  /** The website the visitor typed (bare domain or full URL — the server normalizes it). */
  url: string;
  /** Kick off the parallel Google sign-in (config runs alongside the artifact, not as a gate). */
  onSignIn: () => void;
  /** Go back to the entry screen to try a different website. */
  onRestart: () => void;
  /** Injectable EventSource factory for tests; defaults to the real browser EventSource. */
  eventSourceFactory?: (url: string) => EventSourceLike;
}

type Status = "streaming" | "done" | "error";

export function DeliverablePreview(props: DeliverablePreviewProps): React.JSX.Element {
  const { url, onSignIn, onRestart, eventSourceFactory } = props;
  const [header, setHeader] = useState<DeliverableStartDto | null>(null);
  const [sections, setSections] = useState<DeliverableSectionDto[]>([]);
  const [status, setStatus] = useState<Status>("streaming");
  // Keep the live handle in a ref so the cleanup closes exactly the stream this effect opened.
  const handleRef = useRef<DeliverableStreamHandle | null>(null);

  useEffect(() => {
    setHeader(null);
    setSections([]);
    setStatus("streaming");
    const handle = openDeliverableStream({
      url,
      eventSourceFactory,
      onStart: (start) => setHeader(start),
      onSection: (section) =>
        // Append in order, de-duping by index so a reconnect replay can't double-render a section.
        setSections((prev) =>
          prev.some((s) => s.index === section.index)
            ? prev
            : [...prev, section].sort((a, b) => a.index - b.index),
        ),
      onDone: () => setStatus("done"),
      // Only the *first* frame failing is a real error; EventSource also fires onerror when the server ends
      // the stream, so once we're done we ignore it.
      onError: () => setStatus((s) => (s === "done" ? s : "error")),
    });
    handleRef.current = handle;
    return () => handle.close();
  }, [url, eventSourceFactory]);

  const kinds = ONBOARDING.deliverable.kinds;

  return (
    <div className="deliverable">
      <div className="deliverable__main">
        <header className="deliverable__head">
          <PopMark className="deliverable__mark" />
          <h1 className="deliverable__title">{header?.title ?? ONBOARDING.deliverable.working}</h1>
          {header?.subtitle && <p className="deliverable__sub">{header.subtitle}</p>}
        </header>

        {status === "error" && sections.length === 0 ? (
          <p className="deliverable__error" role="alert">
            {ONBOARDING.deliverable.error}
          </p>
        ) : (
          <ol className="deliverable__sections" aria-label={header?.title ?? "Your deliverable"}>
            {sections.map((s) => (
              <li key={s.id} className="deliverable__section">
                <span className={`deliverable__badge deliverable__badge--${s.kind}`}>{kinds[s.kind]}</span>
                <h2 className="deliverable__section-title">{s.heading}</h2>
                <p className="deliverable__section-body">{s.body}</p>
              </li>
            ))}
          </ol>
        )}

        {status === "streaming" && (
          <p className="deliverable__working" role="status">
            <span className="deliverable__spinner" aria-hidden="true" />
            {ONBOARDING.deliverable.working}
          </p>
        )}
        {status === "done" && (
          <p className="deliverable__done" role="status">
            {ONBOARDING.deliverable.ready}
          </p>
        )}
      </div>

      {/* Config-in-parallel: the sign-in lives beside the artifact, never gating it. */}
      <aside className="deliverable__aside">
        <h2 className="deliverable__aside-title">{ONBOARDING.deliverable.parallelTitle}</h2>
        <p className="deliverable__aside-sub">{ONBOARDING.deliverable.parallelSub}</p>
        <button className="btn btn--primary" type="button" onClick={onSignIn}>
          {ONBOARDING.googleCta}
        </button>
        <button className="linklike deliverable__restart" type="button" onClick={onRestart}>
          {ONBOARDING.deliverable.restart}
        </button>
        <p className="deliverable__reassurance">{ONBOARDING.reassurance}</p>
      </aside>
    </div>
  );
}
