/**
 * #633 outcome-first onboarding — the live deliverable view.
 *
 * The moment a visitor types their website and asks to see it, we fetch the public deliverable as one JSON
 * document and reveal it section by section. The Google sign-in
 * (the only "config") sits *alongside* the streaming artifact, never in front of it: the visitor watches a
 * deliverable appear with zero setup, and signs in when (and if) they like what they see.
 *
 * The fetch is injectable (`fetchImpl`) so this renders under jsdom in tests with a fake source. If the
 * preview can't be built we degrade honestly to an error line + the sign-in path (#200 §3: no faked
 * artifact). Everything returned is server-sanitized text rendered as React children — never raw markup.
 */
import { useEffect, useRef, useState } from "react";
import { ONBOARDING } from "../brand.js";
import type { DeliverableSectionDto, DeliverableStartDto } from "../api/deliverable.js";
import { fetchDemoDeliverable, type FetchLike } from "../api/demo.js";
import { PopMark } from "./PopMark.js";

export interface DeliverablePreviewProps {
  /** The website the visitor typed (bare domain or full URL — the server normalizes it). */
  url: string;
  /** Kick off the parallel Google sign-in (config runs alongside the artifact, not as a gate). */
  onSignIn: () => void;
  /** Go back to the entry screen to try a different website. */
  onRestart: () => void;
  /** Injectable fetch for tests; defaults to the real network call. */
  fetchImpl?: FetchLike;
  /** Per-section reveal delay. `<= 0` reveals all sections immediately for tests. */
  revealDelayMs?: number;
}

type Status = "streaming" | "done" | "error";
const DEFAULT_REVEAL_MS = 550;

export function DeliverablePreview(props: DeliverablePreviewProps): React.JSX.Element {
  const { url, onSignIn, onRestart, fetchImpl, revealDelayMs = DEFAULT_REVEAL_MS } = props;
  const [header, setHeader] = useState<DeliverableStartDto | null>(null);
  const [sections, setSections] = useState<DeliverableSectionDto[]>([]);
  const [revealed, setRevealed] = useState(0);
  const [status, setStatus] = useState<Status>("streaming");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setHeader(null);
    setSections([]);
    setRevealed(0);
    setStatus("streaming");

    void fetchDemoDeliverable(url, { fetchImpl, signal: controller.signal })
      .then((plan) => {
        if (controller.signal.aborted) return;
        setHeader({
          business: plan.business,
          title: plan.title,
          subtitle: plan.subtitle,
          sectionCount: plan.sections.length,
        });
        setSections(plan.sections.map((section, index) => ({ ...section, index })));
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });

    return () => controller.abort();
  }, [url, fetchImpl]);

  useEffect(() => {
    if (sections.length === 0) return;
    if (revealDelayMs <= 0) {
      setRevealed(sections.length);
      setStatus("done");
      return;
    }
    if (revealed >= sections.length) {
      setStatus("done");
      return;
    }
    const id = window.setTimeout(() => setRevealed((n) => Math.min(n + 1, sections.length)), revealDelayMs);
    return () => window.clearTimeout(id);
  }, [sections, revealed, revealDelayMs]);

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
            {sections.slice(0, revealed).map((s) => (
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
