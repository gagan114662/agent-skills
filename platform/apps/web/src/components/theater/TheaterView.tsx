/**
 * The live agent-theater (issue #624) — the "watch the agents work" screen.
 *
 * One screen, the whole fleet: every working agent gets a lane, and each lane streams that agent's real
 * trace as it happens — reasoning → action → artifact — over SSE (`useTheaterStream`). This replaces the
 * spinner with the actual work product flowing by. It is strictly READ-ONLY and renders every streamed
 * summary as plain React text (content-as-data, #200): nothing here is executed, navigated to, or trusted
 * as an instruction. Add `?run=<id>` to focus a single run; otherwise it watches the workspace fleet.
 */
import { useEffect, useRef, useState } from "react";
import { THEATER } from "../../brand.js";
import { Link } from "../../routing.js";
import { api } from "../../api/client.js";
import { useAppState } from "../../store/StoreContext.js";
import { EmptyState } from "../EmptyState.js";
import type { TheaterPhase, TheaterEventDto, TheaterRunDto } from "../../api/theater.js";
import type { AgentTraceDto, AgentTraceEventDto } from "../../api/types.js";
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

function prettyPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

function formatCost(micros: number | null): string | null {
  if (micros === null) return null;
  return "$" + (micros / 1_000_000).toFixed(6);
}

function eventMeta(event: AgentTraceEventDto): string {
  const bits = [
    "#" + event.seq,
    event.type,
    "turn " + event.turn,
    new Date(event.occurredAt).toLocaleTimeString(),
  ];
  if (event.label) bits.push(event.label);
  return bits.join(" · ");
}

function TraceEventRow({ event }: { event: AgentTraceEventDto }): React.JSX.Element {
  const cost = formatCost(event.costMicros);
  const hasUsage = event.inputTokens !== null || event.outputTokens !== null || cost !== null;
  return (
    <li className="theater-trace__event">
      <div className="theater-trace__event-head">
        <span>{eventMeta(event)}</span>
        {hasUsage && (
          <span className="theater-trace__usage">
            {event.inputTokens ?? 0} in / {event.outputTokens ?? 0} out{cost ? " / " + cost : ""}
          </span>
        )}
      </div>
      <pre className="theater-trace__payload">{prettyPayload(event.payload)}</pre>
    </li>
  );
}

function TracePanel({
  trace,
  loading,
  error,
}: {
  trace: AgentTraceDto | null;
  loading: boolean;
  error: string | null;
}): React.JSX.Element | null {
  if (loading) return <p className="theater-trace theater-trace--loading">{THEATER.traceLoading}</p>;
  if (error) return <p className="theater-trace theater-trace--error" role="alert">{error}</p>;
  if (!trace) return null;

  return (
    <section className="theater-trace" aria-label={THEATER.traceRegion}>
      <header className="theater-trace__head">
        <span>
          {trace.run.eventCount} events · {trace.run.status}
        </span>
        <span>
          {trace.run.inputTokens} in / {trace.run.outputTokens} out
        </span>
      </header>
      {trace.events.length === 0 ? (
        <p className="theater-trace__empty">{THEATER.traceEmpty}</p>
      ) : (
        <ol className="theater-trace__list">
          {trace.events.map((event) => (
            <TraceEventRow key={event.id} event={event} />
          ))}
        </ol>
      )}
    </section>
  );
}

function AgentLane({ lane, workspaceId }: { lane: TheaterLane; workspaceId: string }): React.JSX.Element {
  const feedRef = useRef<HTMLOListElement>(null);
  const [trace, setTrace] = useState<AgentTraceDto | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
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
  async function openTrace(): Promise<void> {
    if (traceLoading) return;
    setTraceLoading(true);
    setTraceError(null);
    try {
      setTrace(await api.traces.get(workspaceId, lane.run.id));
    } catch (e) {
      setTraceError(e instanceof Error ? e.message : THEATER.traceLoadError);
    } finally {
      setTraceLoading(false);
    }
  }

  return (
    <section className="theater-lane" aria-label={laneName(lane.run) + " activity"}>
      <header className="theater-lane__head">
        <span className="theater-lane__name">{laneName(lane.run)}</span>
        <div className="theater-lane__actions">
          <button className="theater-lane__trace" onClick={() => void openTrace()} disabled={traceLoading}>
            {trace ? THEATER.refreshTrace : THEATER.openTrace}
          </button>
          <span
            className={"theater-lane__chip theater-lane__chip--" + (working ? "working" : "done")}
          >
            {working ? THEATER.working : THEATER.done}
          </span>
        </div>
      </header>
      <ol className="theater-lane__feed" ref={feedRef}>
        {lane.events.map((event) => (
          <PhaseRow key={event.id} event={event} />
        ))}
      </ol>
      <TracePanel trace={trace} loading={traceLoading} error={traceError} />
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
            <AgentLane key={lane.run.id} lane={lane} workspaceId={workspaceId!} />
          ))}
        </div>
      )}
    </main>
  );
}
