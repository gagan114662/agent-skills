/**
 * Instant demo / sandbox (issue #610) — the no-signup "WOW".
 *
 * A standalone PUBLIC page (mounted at `/demo`, before the auth boundary): a prospect types their own
 * website and, within seconds and with ZERO account, watches a real, personalized marketing deliverable
 * build itself section by section — then is invited to sign up to put their agents to work for real.
 *
 * It reuses the #633 deliverable generator through the single-shot `GET /onboarding/deliverable` endpoint
 * (see `api/demo.ts`): one fetch returns the whole artifact, and this component runs its own paced reveal
 * so the build feels live without ever making the visitor wait the full ~60s budget. Everything rendered
 * is server-sanitized text shown as React children — never raw markup (#200 §3: no faked artifact, and we
 * degrade honestly to an error line if the build fails).
 *
 * The fetch and the reveal cadence are injectable so the whole flow renders under jsdom in tests.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND } from "../../brand.js";
import { Link } from "../../routing.js";
import { PublicDoorFooter, PublicDoorNav } from "../onboarding/PublicDoorNav.js";
import {
  DemoError,
  fetchDemoDeliverable,
  type DemoDeliverableDto,
  type DemoSectionDto,
  type FetchLike,
} from "../../api/demo.js";
import { trackAcquisitionEvent } from "../../acquisition-events.js";

/** Human label per deliverable kind — mirrors the onboarding deliverable badges so styling is shared. */
const KIND_LABEL: Record<DemoSectionDto["kind"], string> = {
  insight: "Insight",
  action: "Action plan",
  draft: "Ready to use",
};

/** All demo copy lives here (this module is intentionally self-contained — it is not a brand-chrome surface). */
const COPY = {
  eyebrow: "Live demo · no signup",
  headline: "See what your AI marketing team makes for you",
  sub: "Drop in your website and watch a real, personalized growth deliverable build itself in seconds. No account, no setup — it's yours to keep.",
  label: "Your website",
  placeholder: "yourcompany.com",
  submit: "Build my free deliverable",
  submitting: "Building…",
  example: "Try an example",
  exampleUrl: "acme.com",
  building: "Building your deliverable — watch it appear, section by section…",
  ready: "Done — that's a real sample your agents made, with zero setup.",
  ctaTitle: (host: string): string => `Want this working on ${host} for real?`,
  ctaSub: (name: string): string =>
    `Everything above is a free sample. Sign up and your ${name} agents get to work for real — drafting, ` +
    `researching, and planning around the clock. You approve anything before it leaves the building.`,
  ctaPrimary: "Start free — no card needed",
  ctaSecondary: "Sign in",
  restart: "Try another website",
  reassurance:
    "No account needed. Nothing here is saved or sent — this is a private preview, just for you.",
} as const;

const DEMO_INTENT_KEY = "ipop-demo-intent";

type Phase = "idle" | "building" | "ready";

export interface DemoSandboxProps {
  /** Injectable fetch for tests; defaults to the real network call. */
  fetchImpl?: FetchLike;
  /** Per-section reveal delay (ms). `<= 0` reveals everything at once — used by tests for instant runs. */
  revealDelayMs?: number;
}

/** Default cadence: ~0.65s/section keeps a 6-section build around ~4s — visibly live, far inside ~60s. */
const DEFAULT_REVEAL_MS = 650;

export function DemoSandbox(props: DemoSandboxProps): React.JSX.Element {
  const { fetchImpl, revealDelayMs = DEFAULT_REVEAL_MS } = props;

  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<DemoDeliverableDto | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const completedHostRef = useRef<string | null>(null);

  // Abort any in-flight fetch when a new one starts or the component unmounts (no setState-after-unmount).
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const build = useCallback(
    async (rawUrl: string): Promise<void> => {
      const url = rawUrl.trim();
      if (url === "") {
        setError("Enter your website to see your demo — e.g. acme.com.");
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError(null);
      setPlan(null);
      setRevealed(0);
      setPhase("building");
      completedHostRef.current = null;
      trackAcquisitionEvent("demo-start", { url, source: "demo" });

      try {
        const result = await fetchDemoDeliverable(url, { fetchImpl, signal: controller.signal });
        if (controller.signal.aborted) return;
        setPlan(result);
      } catch (err) {
        if (controller.signal.aborted) return;
        setPhase("idle");
        setError(
          err instanceof DemoError ? err.message : "Something went wrong — please try again.",
        );
      }
    },
    [fetchImpl],
  );

  // Paced reveal: once the plan lands, surface one section at a time so the build looks live. The whole
  // artifact is already in hand, so this is purely cosmetic — and instant when revealDelayMs <= 0 (tests).
  useEffect(() => {
    if (!plan) return;
    const total = plan.sections.length;
    if (revealDelayMs <= 0 || total === 0) {
      setRevealed(total);
      setPhase("ready");
      return;
    }
    setRevealed(1);
    let shown = 1;
    const timer = setInterval(() => {
      shown += 1;
      setRevealed(shown);
      if (shown >= total) {
        clearInterval(timer);
        setPhase("ready");
      }
    }, revealDelayMs);
    return () => clearInterval(timer);
  }, [plan, revealDelayMs]);

  useEffect(() => {
    if (phase !== "ready" || !plan || completedHostRef.current === plan.business.host) return;
    completedHostRef.current = plan.business.host;
    trackAcquisitionEvent("demo-complete", {
      url: plan.business.url,
      host: plan.business.host,
      source: "demo",
      sectionCount: plan.sections.length,
    });
  }, [phase, plan]);

  const signupHref = plan
    ? `/signup?source=demo&demoHost=${encodeURIComponent(plan.business.host)}&demoUrl=${encodeURIComponent(
        plan.business.url,
      )}`
    : "/signup?source=demo";

  const onDemoSignup = (): void => {
    if (!plan) return;
    try {
      window.sessionStorage.setItem(
        DEMO_INTENT_KEY,
        JSON.stringify({
          url: plan.business.url,
          host: plan.business.host,
          title: plan.title,
          sectionCount: plan.sections.length,
        }),
      );
    } catch {
      // Storage is best-effort; the query string still preserves the host for the next step.
    }
    trackAcquisitionEvent("demo-to-signup", {
      url: plan.business.url,
      host: plan.business.host,
      source: "demo",
      sectionCount: plan.sections.length,
    });
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const formUrl = new FormData(e.currentTarget).get("url");
    void build(typeof formUrl === "string" ? formUrl : input);
  };

  const onRestart = (): void => {
    abortRef.current?.abort();
    setPhase("idle");
    setPlan(null);
    setRevealed(0);
    setError(null);
    completedHostRef.current = null;
  };

  const sections = plan?.sections.slice(0, revealed) ?? [];

  return (
    <div className="demo">
      <PublicDoorNav className="demo__nav" startHref="/start#onboard-target" />
      <header className="demo__head">
        <p className="demo__eyebrow">{COPY.eyebrow}</p>
        <h1 className="demo__headline">{plan ? plan.title : COPY.headline}</h1>
        <p className="demo__sub">{plan ? plan.subtitle : COPY.sub}</p>
      </header>

      {phase === "idle" && (
        <form className="demo__form" onSubmit={onSubmit} noValidate>
          <label className="demo__label" htmlFor="demo-url">
            {COPY.label}
          </label>
          <div className="demo__field">
            <input
              id="demo-url"
              name="url"
              className="demo__input"
              type="text"
              inputMode="url"
              autoComplete="url"
              placeholder={COPY.placeholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "demo-error" : undefined}
            />
            <button className="btn btn--primary demo__submit" type="submit">
              {COPY.submit}
            </button>
          </div>
          {error && (
            <p id="demo-error" className="demo__error" role="alert">
              {error}
            </p>
          )}
          <button
            className="linklike demo__example"
            type="button"
            onClick={() => {
              setInput(COPY.exampleUrl);
              void build(COPY.exampleUrl);
            }}
          >
            {COPY.example}
          </button>
        </form>
      )}

      {(phase === "building" || phase === "ready") && (
        <ol
          className="demo__sections deliverable__sections"
          aria-label={plan?.title ?? "Your deliverable"}
        >
          {sections.map((s) => (
            <li key={s.id} className="demo__section deliverable__section">
              <span className={`deliverable__badge deliverable__badge--${s.kind}`}>
                {KIND_LABEL[s.kind]}
              </span>
              <h2 className="deliverable__section-title">{s.heading}</h2>
              <p className="deliverable__section-body">{s.body}</p>
            </li>
          ))}
        </ol>
      )}

      {phase === "building" && (
        <p className="demo__working" role="status">
          <span className="demo__spinner deliverable__spinner" aria-hidden="true" />
          {COPY.building}
        </p>
      )}

      {phase === "ready" && plan && (
        <section className="demo__cta" aria-label="Sign up">
          <p className="demo__done" role="status">
            {COPY.ready}
          </p>
          <h2 className="demo__cta-title">{COPY.ctaTitle(plan.business.host)}</h2>
          <p className="demo__cta-sub">{COPY.ctaSub(BRAND.name)}</p>
          <div className="demo__cta-actions">
            <Link href={signupHref} className="btn btn--primary demo__cta-primary" onClick={onDemoSignup}>
              {COPY.ctaPrimary}
            </Link>
            <Link href="/login" className="linklike demo__cta-secondary">
              {COPY.ctaSecondary}
            </Link>
          </div>
          <button className="linklike demo__restart" type="button" onClick={onRestart}>
            {COPY.restart}
          </button>
        </section>
      )}

      <p className="demo__reassurance">{COPY.reassurance}</p>
      <PublicDoorFooter className="demo__footer" />
    </div>
  );
}
