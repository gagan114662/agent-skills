/**
 * The #784 first-run onboarding — the demo-to-product leap, in the new experience system.
 *
 * One flow, five beats, all on the near-black canvas with a single coral pop:
 *   1. door      — a warm Instrument-Serif greeting and ONE input ("what are we marketing today?"). Nothing else.
 *   2. reading    — the fleet wakes, reads the REAL site, introduces itself in the thread, narrates a real finding.
 *   3. connect    — THE MAGIC: guided Cowork-style connects, ONE Allow at a time (gmail → reddit/x → your site),
 *                   each IMMEDIATELY paid off with a real, visible result that uses it.
 *   4. deliverable — one real deliverable built from those connections; one approve and it ships.
 *   5. shipped    — a small, earned delight. Sends/spend stay human-gated; money is the only hard gate.
 *
 * Presentational only — every datum (the finding, each connect payoff, the deliverable) comes from an injected
 * {@link OnboardingProvider}, and every word comes from {@link ONBOARD_COPY} in the cheeky Innocent voice. The
 * surface is gated default-OFF (#784 `onboarding-flag`); this component renders nothing in production until then.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { experienceTokenStyle } from "../../design/ipop-experience-tokens.js";
import { navigate } from "../../routing.js";
import { PopMark } from "../PopMark.js";
import { ONBOARD_COPY, greeting } from "./copy.js";
import {
  createDefaultProvider,
  OnboardingReadError,
  type ConnectResult,
  type ConnectTool,
  type DeliverableDraft,
  type OnboardingProvider,
  type SiteFinding,
} from "./provider.js";

type Phase = "door" | "reading" | "connect" | "deliverable" | "shipped";

/** The copy shape each connector reads (the cheeky prompt + the framing line above its real payoff). */
interface ConnectorCopy {
  readonly tool: string;
  readonly prompt: string;
  readonly resultLead: string;
}

/** The guided connect order + the copy each step reads. The three tools the issue calls out, in order. */
const CONNECTORS: readonly { tool: ConnectTool; copy: ConnectorCopy }[] = [
  { tool: "gmail", copy: ONBOARD_COPY.connect.gmail },
  { tool: "social", copy: ONBOARD_COPY.connect.social },
  { tool: "site", copy: ONBOARD_COPY.connect.site },
];

export interface OnboardingExperienceProps {
  /** The data seam (defaults to the live provider: a REAL site read + deterministic payoffs). */
  provider?: OnboardingProvider;
  /** The hour (0–23) the greeting reads from — injectable so the door greeting is deterministic in tests. */
  hour?: number;
  /** The signed-in member's first name for the greeting, if known. */
  name?: string | null;
  /** Where "take me in" goes (defaults to the app root). Injectable for tests. */
  onEnterApp?: () => void;
}

/** Render one connect payoff — discriminated by tool, so each reads as the real thing it is. */
function ConnectPayoff({ result }: { result: ConnectResult }): React.JSX.Element {
  if (result.tool === "gmail") {
    return (
      <div className="onboard-result">
        <p className="onboard-result__lead">{ONBOARD_COPY.connect.gmail.resultLead}</p>
        <div className="onboard-mail">
          <p className="onboard-mail__meta">
            <span className="onboard-mail__from">{result.lead.from}</span>
            <span className="onboard-mail__subject">{result.lead.subject}</span>
          </p>
          <p className="onboard-mail__draft">{result.draft}</p>
        </div>
      </div>
    );
  }
  if (result.tool === "social") {
    return (
      <div className="onboard-result">
        <p className="onboard-result__lead">{ONBOARD_COPY.connect.social.resultLead}</p>
        <ul className="onboard-threads">
          {result.threads.map((t) => (
            <li key={t.title} className="onboard-thread">
              <span className="onboard-thread__source">{t.source}</span>
              <span className="onboard-thread__title">{t.title}</span>
              <span className="onboard-thread__draft">{t.draft}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="onboard-result">
      <p className="onboard-result__lead">{ONBOARD_COPY.connect.site.resultLead}</p>
      <div className="onboard-hero">
        <p className="onboard-hero__before">{result.before}</p>
        <p className="onboard-hero__after">{result.after}</p>
      </div>
    </div>
  );
}

export function OnboardingExperience(props: OnboardingExperienceProps): React.JSX.Element {
  const provider = props.provider ?? createDefaultProvider();
  const hour = props.hour ?? new Date().getHours();
  const onEnterApp = props.onEnterApp ?? (() => navigate("/"));

  const [phase, setPhase] = useState<Phase>("door");
  const [input, setInput] = useState("");
  const [doorError, setDoorError] = useState<string | null>(null);

  const [finding, setFinding] = useState<SiteFinding | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const [results, setResults] = useState<ConnectResult[]>([]);
  const [connecting, setConnecting] = useState(false);

  const [deliverable, setDeliverable] = useState<DeliverableDraft | null>(null);
  const [building, setBuilding] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [shipping, setShipping] = useState(false);
  // Guards the build effect against re-entry without putting `building` in its deps (which would let the
  // effect's cleanup cancel its own in-flight build the moment `building` flips true).
  const buildingRef = useRef(false);

  // Wake the fleet and read the real site. Shared by the door submit and the read-error retry.
  const startReading = useCallback(
    async (value: string): Promise<void> => {
      setReadError(null);
      setFinding(null);
      try {
        const f = await provider.readSite(value);
        setFinding(f);
      } catch (err) {
        setReadError(
          err instanceof OnboardingReadError ? err.message : ONBOARD_COPY.reading.error,
        );
      }
    },
    [provider],
  );

  const onDoorSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const value = input.trim();
    if (value === "") {
      setDoorError(ONBOARD_COPY.door.needInput);
      return;
    }
    setDoorError(null);
    setPhase("reading");
    void startReading(value);
  };

  const allow = async (tool: ConnectTool): Promise<void> => {
    setConnecting(true);
    try {
      const result = await provider.connect(tool, input);
      setResults((prev) => [...prev, result]);
    } finally {
      setConnecting(false);
    }
  };

  // Build the first deliverable the moment we enter that phase, and again after a reject (deliverable → null).
  useEffect(() => {
    if (phase !== "deliverable" || deliverable || buildingRef.current) return;
    let live = true;
    buildingRef.current = true;
    setBuilding(true);
    void provider
      .buildDeliverable(input)
      .then((d) => {
        if (live) setDeliverable(d);
      })
      .finally(() => {
        buildingRef.current = false;
        if (live) setBuilding(false);
      });
    return () => {
      live = false;
    };
  }, [phase, deliverable, provider, input]);

  const approve = async (): Promise<void> => {
    setShipping(true);
    try {
      await provider.ship();
      setPhase("shipped");
    } finally {
      setShipping(false);
    }
  };

  const reject = (): void => {
    setRejected(true);
    setDeliverable(null); // triggers a rebuild ("take two")
  };

  const connectedCount = results.length;
  const nextConnector = CONNECTORS[connectedCount];

  return (
    <div className="onboard" data-phase={phase} style={experienceTokenStyle("onboarding")}>
      <div className="onboard__inner">
        {/* ---- 1. the door ------------------------------------------------------------------ */}
        {phase === "door" && (
          <form className="onboard-door" onSubmit={onDoorSubmit} noValidate>
            <PopMark className="onboard__mark" />
            <h1 className="onboard-door__greeting">{greeting(hour, props.name)}</h1>
            <label className="onboard-door__label" htmlFor="onboard-target">
              {ONBOARD_COPY.door.inputLabel}
            </label>
            <div className="onboard-door__field">
              <input
                id="onboard-target"
                className="onboard-input"
                type="text"
                value={input}
                placeholder={ONBOARD_COPY.door.placeholder}
                onChange={(e) => setInput(e.target.value)}
                aria-invalid={doorError ? true : undefined}
                aria-describedby={doorError ? "onboard-door-error" : undefined}
                autoFocus
              />
              <button className="onboard-cta" type="submit">
                {ONBOARD_COPY.door.submit}
              </button>
            </div>
            {doorError && (
              <p id="onboard-door-error" className="onboard-error" role="alert">
                {doorError}
              </p>
            )}
            <p className="onboard-door__reassurance">{ONBOARD_COPY.door.reassurance}</p>
          </form>
        )}

        {/* ---- 2. the fleet wakes + reads the real site ------------------------------------- */}
        {phase === "reading" && (
          <section className="onboard-reading" aria-label="the fleet reads your site">
            {!finding && !readError && (
              <p className="onboard-working" role="status">
                <span className="onboard-spinner" aria-hidden="true" />
                {ONBOARD_COPY.reading.working}
              </p>
            )}

            {readError && (
              <div className="onboard-reading__error">
                <p className="onboard-error" role="alert">
                  {readError}
                </p>
                <button
                  className="onboard-cta onboard-cta--ghost"
                  type="button"
                  onClick={() => void startReading(input)}
                >
                  {ONBOARD_COPY.door.submit}
                </button>
              </div>
            )}

            {finding && (
              <>
                <ul className="onboard-thread-list">
                  {ONBOARD_COPY.reading.intros.map((intro) => (
                    <li key={intro.who} className="onboard-msg">
                      <span className="onboard-msg__who">{intro.who}</span>
                      <span className="onboard-msg__line">{intro.line}</span>
                    </li>
                  ))}
                  <li className="onboard-msg onboard-msg--finding">
                    <span className="onboard-msg__who">scout</span>
                    <span className="onboard-msg__line">
                      {ONBOARD_COPY.reading.findingLead} {finding.finding}
                    </span>
                  </li>
                </ul>
                <button
                  className="onboard-cta"
                  type="button"
                  onClick={() => setPhase("connect")}
                >
                  {ONBOARD_COPY.reading.next}
                </button>
              </>
            )}
          </section>
        )}

        {/* ---- 3. THE MAGIC: guided connects, each with an immediate real payoff ------------- */}
        {phase === "connect" && (
          <section className="onboard-connect" aria-label="connect your tools">
            <h2 className="onboard-connect__title">{ONBOARD_COPY.connect.sectionTitle}</h2>

            {/* Accumulated payoffs — the thread of real work done with the user's own accounts. */}
            {results.map((result) => (
              <div key={result.tool} className="onboard-connected">
                <span className="onboard-badge">{ONBOARD_COPY.connect.doneBadge}</span>
                <ConnectPayoff result={result} />
              </div>
            ))}

            {/* The current Allow prompt, one tool at a time. */}
            {nextConnector && (
              <div className="onboard-allow">
                <p className="onboard-allow__prompt">{nextConnector.copy.prompt}</p>
                <button
                  className="onboard-cta"
                  type="button"
                  disabled={connecting}
                  onClick={() => void allow(nextConnector.tool)}
                >
                  {connecting ? ONBOARD_COPY.connect.allowing : ONBOARD_COPY.connect.allow}
                </button>
              </div>
            )}

            {/* All three connected — onto the real deliverable. */}
            {!nextConnector && (
              <button
                className="onboard-cta"
                type="button"
                onClick={() => setPhase("deliverable")}
              >
                {ONBOARD_COPY.connect.toDeliverable}
              </button>
            )}
          </section>
        )}

        {/* ---- 4. one real deliverable → one approve → it ships ----------------------------- */}
        {phase === "deliverable" && (
          <section className="onboard-deliverable" aria-label="your first deliverable">
            <p className="onboard-eyebrow">{ONBOARD_COPY.deliverable.eyebrow}</p>

            {rejected && !deliverable && (
              <p className="onboard-redo">{ONBOARD_COPY.deliverable.redo}</p>
            )}

            {building && (
              <p className="onboard-working" role="status">
                <span className="onboard-spinner" aria-hidden="true" />
                {ONBOARD_COPY.deliverable.building}
              </p>
            )}

            {deliverable && (
              <div className="onboard-card">
                <h2 className="onboard-card__title">{deliverable.title}</h2>
                <p className="onboard-card__body">{deliverable.body}</p>
                {deliverable.spendsMoney && (
                  <p className="onboard-card__money">{ONBOARD_COPY.deliverable.moneyGate}</p>
                )}
                <p className="onboard-card__consequence">
                  {ONBOARD_COPY.deliverable.consequence}
                </p>
                <div className="onboard-card__actions">
                  <button
                    className="onboard-cta"
                    type="button"
                    disabled={shipping}
                    onClick={() => void approve()}
                  >
                    {ONBOARD_COPY.deliverable.approve}
                  </button>
                  <button
                    className="onboard-cta onboard-cta--ghost"
                    type="button"
                    disabled={shipping}
                    onClick={reject}
                  >
                    {ONBOARD_COPY.deliverable.reject}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ---- 5. shipped — a small, earned delight ---------------------------------------- */}
        {phase === "shipped" && (
          <section className="onboard-shipped" aria-label="shipped">
            <PopMark burst className="onboard__mark" />
            <h1 className="onboard-shipped__headline">{ONBOARD_COPY.shipped.headline}</h1>
            <p className="onboard-shipped__sub">{ONBOARD_COPY.shipped.sub}</p>
            <button className="onboard-cta" type="button" onClick={onEnterApp}>
              {ONBOARD_COPY.shipped.enter}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
