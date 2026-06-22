/**
 * The live agent-theater (issue #624) — the "watch the agents work" screen.
 *
 * One screen, the whole fleet: every working agent gets a lane, and each lane streams that agent's real
 * trace as it happens — reasoning → action → artifact — over SSE (`useTheaterStream`). This replaces the
 * spinner with the actual work product flowing by. It is strictly READ-ONLY and renders every streamed
 * summary as plain React text (content-as-data, #200): nothing here is executed, navigated to, or trusted
 * as an instruction. Add `?run=<id>` to focus a single run; otherwise it watches the workspace fleet.
 */
import { useEffect, useRef } from "react";
import { THEATER } from "../../brand.js";
import { Link } from "../../routing.js";
import { useAppState } from "../../store/StoreContext.js";
import { EmptyState } from "../EmptyState.js";
import type { TheaterPhase, TheaterEventDto, TheaterRunDto } from "../../api/theater.js";
import { useTheaterStream, type TheaterLane, type TheaterStatus } from "./useTheaterStream.js";

/** Glyph + voice label for each watchable phase. */
const PHASE_META: Record<TheaterPhase, { glyph: string; label: string }> = {
  context: { glyph: "📋", label: THEATER.phaseContext },
  reasoning: { glyph: "💭", label: THEATER.phaseReasoning },
  action: { glyph: "⚡", label: THEATER.phaseAction },
  artifact: { glyph: "✨", label: THEATER.phaseArtifact },
  approval: { glyph: "🛡", label: THEATER.phaseApproval },
};

const STATUS_LABEL: Record<TheaterStatus, string> = {
  idle: THEATER.statusConnecting,
  connecting: THEATER.statusConnecting,
  live: THEATER.statusLive,
  reconnecting: THEATER.statusReconnecting,
};

/** A run's human label: its own label, else the member id, else a generic stand-in. */
function laneName(run: TheaterRunDto): string {
  return run.label?.trim() || run.agentMemberId || "Agent";
}

/** Read a focused run id off `?run=` (single-agent theater); null watches the whole fleet. */
function focusedRunId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("run") ?? undefined;
}

function PhaseRow({ event }: { event: TheaterEventDto }): React.JSX.Element {
  const meta = PHASE_META[event.phase];
  return (
    <li className={`theater-step theater-step--${event.phase}`}>
      <span className="theater-step__glyph" aria-hidden="true">
        {meta.glyph}
      </span>
      <span className="theater-step__body">
        <span className="theater-step__label">
          {meta.label}
          {event.label ? <span className="theater-step__tool"> · {event.label}</span> : null}
        </span>
        <span className="theater-step__summary">{event.summary}</span>
      </span>
    </li>
  );
}

function AgentLane({ lane }: { lane: TheaterLane }): React.JSX.Element {
  const feedRef = useRef<HTMLOListElement>(null);
  const lastSeq = lane.events.length > 0 ? lane.events[lane.events.length - 1]!.seq : 0;

  // Keep the newest step in view as the agent works. Instant on reduced-motion preference.
  useEffect(() => {
    const el = feedRef.current;
    if (!el || typeof el.scrollTo !== "function") return;
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [lastSeq]);

  const working = lane.run.status === "open";
  return (
    <section className="theater-lane" aria-label={`${laneName(lane.run)} activity`}>
      <header className="theater-lane__head">
        <span className="theater-lane__name">{laneName(lane.run)}</span>
        <span
          className={`theater-lane__chip theater-lane__chip--${working ? "working" : "done"}`}
        >
          {working ? THEATER.working : THEATER.done}
        </span>
      </header>
      <ol className="theater-lane__feed" ref={feedRef}>
        {lane.events.map((event) => (
          <PhaseRow key={event.id} event={event} />
        ))}
      </ol>
    </section>
  );
}

export function TheaterView(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  const runId = focusedRunId();
  const { lanes, status, eventCount } = useTheaterStream(workspaceId, runId);

  return (
    <main className="theater">
      <header className="theater__bar">
        <div className="theater__titles">
          <h1 className="theater__title">{THEATER.title}</h1>
          <p className="theater__subtitle">{THEATER.subtitle}</p>
        </div>
        <div className="theater__meta">
          <span
            className={`theater__status theater__status--${status}`}
            role="status"
            aria-live="polite"
          >
            <span className="theater__status-dot" aria-hidden="true" />
            {STATUS_LABEL[status]}
          </span>
          <span className="theater__counts">
            {lanes.length} {THEATER.agentsLabel} · {eventCount} {THEATER.stepsLabel}
          </span>
          <Link href="/" className="theater__back">
            {THEATER.back}
          </Link>
        </div>
      </header>

      {lanes.length === 0 ? (
        <EmptyState className="theater__empty">{THEATER.empty}</EmptyState>
      ) : (
        <div className="theater__stage">
          {lanes.map((lane) => (
            <AgentLane key={lane.run.id} lane={lane} />
          ))}
        </div>
      )}
    </main>
  );
}
