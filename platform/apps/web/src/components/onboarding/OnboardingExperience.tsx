/**
 * The #784 first-run onboarding — the demo-to-product leap, in the new experience system.
 *
 * One flow, five beats, all on the near-black canvas with a single coral pop:
 *   1. door      — a warm Instrument-Serif greeting and ONE input ("what are we marketing today?"). Nothing else.
 *   2. reading    — the fleet wakes, reads the REAL site, introduces itself in the thread, narrates a real finding,
 *                   and offers one instant no-spend result the user can approve immediately.
 *   3. connect    — THE MAGIC: guided Cowork-style connects, ONE Allow at a time (gmail → reddit/x → your site),
 *                   each IMMEDIATELY paid off with a real, visible result that uses it.
 *   4. deliverable — one real deliverable built from those connections; one approve and it ships.
 *   5. shipped    — a small, earned delight. Spend stays human-gated; no-spend work follows policy.
 *
 * Presentational only — every datum (the finding, each connect payoff, the deliverable) comes from an injected
 * {@link OnboardingProvider}, and every word comes from {@link ONBOARD_COPY} in the cheeky Innocent voice. The
 * surface is gated default-OFF (#784 `onboarding-flag`); this component renders nothing in production until then.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND, SUPPORT_CONTACT } from "../../brand.js";
import { api, googleStartUrl } from "../../api/client.js";
import { experienceTokenStyle } from "../../design/ipop-experience-tokens.js";
import { APP_ROUTES, navigate } from "../../routing.js";
import { PopMark } from "../PopMark.js";
import { ONBOARD_COPY, greeting } from "./copy.js";
import { savePendingFirstRunReceipt } from "./first-run-receipt.js";
import { PublicDoorNav } from "./PublicDoorNav.js";
import {
  createDefaultProvider,
  OnboardingReadError,
  type ConnectResult,
  type ConnectTool,
  type DeliverableDraft,
  type OnboardingProvider,
  type SiteFinding,
  type TeamMission,
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

const NATIVE_IMESSAGE_URL = "imessage://";

const FOOTER_TRUST_LINKS = [
  { href: "/demo", label: "Demo" },
  { href: "/pricing", label: "Pricing" },
  { href: "/company", label: "Company" },
  { href: APP_ROUTES.terms, label: "Terms" },
  { href: APP_ROUTES.privacy, label: "Privacy" },
] as const;

function roomReceipt(
  phase: Phase,
  results: readonly ConnectResult[],
  deliverable: DeliverableDraft | null,
): string {
  if (phase === "shipped") return ONBOARD_COPY.room.receipts.shipped;
  if (deliverable) return ONBOARD_COPY.room.receipts.deliverable;
  if (results.length > 0) return ONBOARD_COPY.room.receipts.connected;
  if (phase === "reading") return ONBOARD_COPY.room.receipts.reading;
  return ONBOARD_COPY.room.receipts.waiting;
}

function CoworkStage({
  phase,
  input,
  finding,
  mission,
  results,
  deliverable,
  readError,
  connectError,
}: {
  phase: Phase;
  input: string;
  finding: SiteFinding | null;
  mission: TeamMission | null;
  results: readonly ConnectResult[];
  deliverable: DeliverableDraft | null;
  readError: string | null;
  connectError: string | null;
}): React.JSX.Element {
  const lanes = ONBOARD_COPY.room.lanes[phase];
  const target = input.trim() || "waiting for the thing";
  const signal =
    mission?.receipts[mission.receipts.length - 1] ??
    (finding ? ONBOARD_COPY.room.receipts.reading : undefined) ??
    readError ??
    connectError ??
    deliverable?.title ??
    roomReceipt(phase, results, deliverable);
  return (
    <aside className="onboard-room" aria-label="ipop cowork room">
      <div className="onboard-room__head">
        <p className="onboard-room__eyebrow">{ONBOARD_COPY.room.eyebrow}</p>
        <h2 className="onboard-room__title">{ONBOARD_COPY.room.title}</h2>
        <p className="onboard-room__sub">{ONBOARD_COPY.room.sub}</p>
      </div>

      <ul className="onboard-room__agents" aria-label="agent team">
        {(mission?.agents ?? ONBOARD_COPY.room.agents).map((agent) => (
          <li
            key={agent.who}
            className="onboard-room-agent"
            data-status={"status" in agent ? agent.status : "idle"}
          >
            <span className="onboard-room-agent__dot" aria-hidden="true" />
            <span className="onboard-room-agent__who">{agent.who}</span>
            <span className="onboard-room-agent__job">
              {"current" in agent ? agent.current : agent.job}
            </span>
          </li>
        ))}
      </ul>

      <div className="onboard-room__desk">
        <p className="onboard-room__label">{ONBOARD_COPY.room.lanesTitle}</p>
        <p className="onboard-room__target">{target}</p>
        <ul className="onboard-room__lanes">
          {lanes.map((lane) => (
            <li key={lane}>{lane}</li>
          ))}
        </ul>
      </div>

      <div className="onboard-room__receipt">
        <span>{ONBOARD_COPY.room.receiptTitle}</span>
        <strong>{signal}</strong>
      </div>

      {mission && (
        <div className="onboard-room__mission" aria-label="team mission receipt">
          <p className="onboard-room__label">mission</p>
          <strong>{mission.objective}</strong>
          <ul className="onboard-room__handoffs">
            {mission.handoffs.map((handoff) => (
              <li key={handoff}>{handoff}</li>
            ))}
          </ul>
          <div className="onboard-room__artifacts">
            {mission.artifacts.map((artifact) => (
              <article key={artifact.title}>
                <span>{artifact.title}</span>
                <p>{artifact.summary}</p>
              </article>
            ))}
          </div>
          <p className="onboard-room__blocked">
            blocked until real access: {mission.blockedPermissions.join(", ")}
          </p>
        </div>
      )}
    </aside>
  );
}

export interface OnboardingExperienceProps {
  /** The data seam (defaults to the live provider: a REAL site read + deterministic payoffs). */
  provider?: OnboardingProvider;
  /** The hour (0–23) the greeting reads from — injectable so the door greeting is deterministic in tests. */
  hour?: number;
  /** The signed-in member's first name for the greeting, if known. */
  name?: string | null;
  /** Where "take me in" goes (defaults to the app root). Injectable for tests. */
  onEnterApp?: () => void;
  /**
   * Starts the real signup OAuth handoff from the public cowork flow. Tests/demos that inject a provider keep
   * using that provider for Gmail payoffs; the production default navigates to Google before claiming access.
   */
  startGoogleAuth?: (input: string) => void | Promise<void>;
  /**
   * The public product experience is iMessage/workspace-first. Tests and connector-specific demos can still
   * force the older guided connector walk-through so those real-connection seams stay covered.
   */
  connectMode?: "workspace" | "guided";
  /** Opens the workspace/iMessage room after the first site-read result. */
  onOpenWorkspace?: (target: string) => void;
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

function InstantDeliverable({
  finding,
  approving,
  onApprove,
}: {
  finding: SiteFinding;
  approving: boolean;
  onApprove: () => void;
}): React.JSX.Element {
  return (
    <article className="onboard-instant" aria-label="instant personalized deliverable">
      <div className="onboard-instant__head">
        <p className="onboard-eyebrow">streaming now</p>
        <h2>{finding.name}'s first useful thing</h2>
      </div>
      <ol className="onboard-instant__steps" aria-label="agent work stream">
        <li>scout read {finding.host}</li>
        <li>quill drafted from the finding</li>
        <li>ready for your approval</li>
      </ol>
      <div className="onboard-instant__draft">
        <span>draft</span>
        <p>
          Lead with this: {finding.finding} Then ship a homepage hero rewrite and a launch-week post
          plan before asking anyone to connect an account.
        </p>
      </div>
      <div className="onboard-instant__actions">
        <button className="onboard-cta" type="button" disabled={approving} onClick={onApprove}>
          {approving ? "approving" : "approve this first result"}
        </button>
      </div>
    </article>
  );
}

function PublicTrustLinks(): React.JSX.Element {
  return (
    <nav className="onboard-trust onboard-trust--footer" aria-label="footer public links">
      {FOOTER_TRUST_LINKS.map((link) => (
        <a key={link.href} className="onboard-trust__link" href={link.href}>
          {link.label}
        </a>
      ))}
    </nav>
  );
}

const MARKETING_ICON_ROW = [
  { key: "market", label: "market", detail: "where to win" },
  { key: "brief", label: "brief", detail: "one-line target" },
  { key: "icp", label: "customer", detail: "ICP folder" },
  { key: "site", label: "website", detail: "site read" },
  { key: "insight", label: "insight", detail: "sharp truth" },
  { key: "creative", label: "creative", detail: "platform draft" },
  { key: "email", label: "email", detail: "reply ready" },
  { key: "seo", label: "search", detail: "intent map" },
  { key: "social", label: "social", detail: "channel test" },
  { key: "paid", label: "paid", detail: "spend dial" },
  { key: "approval", label: "approve", detail: "owner yes" },
  { key: "receipt", label: "receipt", detail: "proof saved" },
] as const;

const MESSAGING_CHANNELS = [
  { key: "imessage", label: "iMessage", detail: "personal room" },
  { key: "whatsapp", label: "WhatsApp", detail: "team thread" },
  { key: "telegram", label: "Telegram", detail: "bot room" },
] as const;

function MarketingIconRow(): React.JSX.Element {
  return (
    <section className="onboard-marketing" aria-label="marketing work preview" data-interactive="false">
      <ol className="onboard-marketing__row" aria-label="decorative marketing capability preview">
        {MARKETING_ICON_ROW.map((item) => (
          <li key={item.key} className="onboard-marketing__item" data-kind={item.key}>
            <span className="onboard-marketing__mark" aria-hidden="true">
              <span className="onboard-marketing__detail">{item.detail}</span>
            </span>
            <span className="onboard-marketing__label">{item.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MessagingChannelRail({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (channel: string) => void;
}): React.JSX.Element {
  return (
    <section className="onboard-message-channels" aria-label="messaging channels">
      {MESSAGING_CHANNELS.map((channel) => (
        <button
          key={channel.key}
          type="button"
          className="onboard-message-channel"
          data-kind={channel.key}
          data-selected={selected === channel.key ? "true" : "false"}
          aria-pressed={selected === channel.key}
          onClick={() => onSelect(channel.key)}
        >
          <span className="onboard-message-channel__mark" aria-hidden="true" />
          <span className="onboard-message-channel__copy">
            <strong>{channel.label}</strong>
            <span>{channel.detail}</span>
          </span>
        </button>
      ))}
    </section>
  );
}

export function OnboardingExperience(props: OnboardingExperienceProps): React.JSX.Element {
  const provider = props.provider ?? createDefaultProvider();
  const hour = props.hour ?? new Date().getHours();
  const onEnterApp = props.onEnterApp ?? (() => navigate(APP_ROUTES.home));
  const onOpenWorkspace = props.onOpenWorkspace;
  const connectMode = props.connectMode ?? (props.provider ? "guided" : "workspace");
  const startGoogleAuth =
    props.startGoogleAuth ??
    (props.provider
      ? null
      : async (value: string): Promise<void> => {
          const status = await api.getGoogleAuthStatus();
          if (!status.configured) throw new Error(status.message);
          window.location.assign(googleStartUrl(value));
        });

  const [phase, setPhase] = useState<Phase>("door");
  const [input, setInput] = useState("");
  const [doorError, setDoorError] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string>("imessage");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [finding, setFinding] = useState<SiteFinding | null>(null);
  const [mission, setMission] = useState<TeamMission | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const [results, setResults] = useState<ConnectResult[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

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
      setMission(null);
      try {
        const f = await provider.readSite(value);
        const team = await provider.startTeam(value, f);
        setFinding(f);
        setMission(team);
        savePendingFirstRunReceipt(value, f, team);
      } catch (err) {
        setReadError(err instanceof OnboardingReadError ? err.message : ONBOARD_COPY.reading.error);
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
    if (tool === "gmail" && startGoogleAuth) {
      setConnecting(true);
      setConnectError(null);
      try {
        await startGoogleAuth(input);
      } catch (err) {
        setConnectError(err instanceof Error ? err.message : ONBOARD_COPY.connect.unavailable);
        setConnecting(false);
      }
      return;
    }
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await provider.connect(tool, input);
      setResults((prev) => [...prev, result]);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : ONBOARD_COPY.connect.unavailable);
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
      <div className="onboard-sunscape" aria-hidden="true">
        <span className="onboard-sunscape__ray onboard-sunscape__ray--one" />
        <span className="onboard-sunscape__ray onboard-sunscape__ray--two" />
        <span className="onboard-sunscape__ray onboard-sunscape__ray--three" />
        <span className="onboard-sunscape__sun" />
      </div>
      <PublicDoorNav />
      <div className="onboard__inner">
        <main className="onboard__primary">
          {/* ---- 1. the door ------------------------------------------------------------------ */}
          {phase === "door" && (
            <form className="onboard-door" onSubmit={onDoorSubmit} noValidate>
              <PopMark className="onboard__mark" />
              <MarketingIconRow />
              <h1 className="onboard-door__greeting">{greeting(hour, props.name)}</h1>
              <MessagingChannelRail
                selected={selectedChannel}
                onSelect={(channel) => {
                  setSelectedChannel(channel);
                  inputRef.current?.focus();
                }}
              />
              <label className="onboard-door__label" htmlFor="onboard-target">
                {ONBOARD_COPY.door.inputLabel}
              </label>
              <div className="onboard-door__field">
                <input
                  ref={inputRef}
                  id="onboard-target"
                  className="onboard-input"
                  type="text"
                  value={input}
                  placeholder={ONBOARD_COPY.door.placeholder}
                  onChange={(e) => setInput(e.target.value)}
                  aria-invalid={doorError ? true : undefined}
                  aria-describedby={doorError ? "onboard-door-error" : undefined}
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
                  <InstantDeliverable
                    finding={finding}
                    approving={shipping}
                    onApprove={() => void approve()}
                  />
                  {connectMode === "guided" ? (
                    <button
                      className="onboard-cta onboard-cta--ghost"
                      type="button"
                      onClick={() => setPhase("connect")}
                    >
                      {ONBOARD_COPY.reading.next}
                    </button>
                  ) : (
                    <a
                      className="onboard-cta onboard-cta--ghost"
                      href={NATIVE_IMESSAGE_URL}
                      onClick={(event) => {
                        if (!onOpenWorkspace) return;
                        event.preventDefault();
                        onOpenWorkspace(input);
                      }}
                    >
                      {ONBOARD_COPY.reading.openRoom}
                    </a>
                  )}
                </>
              )}
            </section>
          )}

          {/* ---- 3. THE MAGIC: guided connects, each with an immediate real payoff when real access exists. */}
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
                  <button
                    className="onboard-cta onboard-cta--ghost"
                    type="button"
                    disabled={connecting}
                    onClick={() => setPhase("deliverable")}
                  >
                    {ONBOARD_COPY.connect.skip}
                  </button>
                  <p className="onboard-allow__note">{ONBOARD_COPY.connect.skipNote}</p>
                  {connectError && (
                    <>
                      <p className="onboard-error" role="alert">
                        {connectError}
                      </p>
                      <button
                        className="onboard-cta onboard-cta--ghost"
                        type="button"
                        onClick={onEnterApp}
                      >
                        {ONBOARD_COPY.connect.realConnections}
                      </button>
                    </>
                  )}
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
                  {results.length > 0
                    ? ONBOARD_COPY.deliverable.building
                    : ONBOARD_COPY.deliverable.buildingSiteOnly}
                </p>
              )}

              {deliverable && (
                <div className="onboard-card">
                  <h2 className="onboard-card__title">{deliverable.title}</h2>
                  {results.length === 0 && (
                    <p className="onboard-card__site-only">{ONBOARD_COPY.deliverable.siteOnly}</p>
                  )}
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
        </main>
        {phase !== "door" && (
          <CoworkStage
            phase={phase}
            input={input}
            finding={finding}
            mission={mission}
            results={results}
            deliverable={deliverable}
            readError={readError}
            connectError={connectError}
          />
        )}
      </div>
      <footer className="onboard__footer">
        <PublicTrustLinks />
        {phase !== "door" && (
          <a className="onboard-trust__support" href={SUPPORT_CONTACT.href}>
            {SUPPORT_CONTACT.email}
          </a>
        )}
      </footer>
    </div>
  );
}
