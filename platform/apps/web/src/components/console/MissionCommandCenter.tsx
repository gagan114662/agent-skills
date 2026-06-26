import type { FounderConsoleDto, MissionControlDto } from "../../api/types.js";
import { CONSOLE, agentColor } from "../../brand.js";
import { fmtCents, fmtElapsed } from "./model.js";

export interface MissionCommandCenterProps {
  mission: MissionControlDto | null;
  founder: FounderConsoleDto | null;
  pendingCount: number;
  shippedCount: number;
  agentLabel: (memberId: string) => string;
}

function percent(value: number): string {
  return Math.round(value * 100) + "%";
}

function statusLine(mission: MissionControlDto | null): string {
  if (!mission) return CONSOLE.commandCenter.loading;
  if (mission.count > 0) return CONSOLE.commandCenter.live(mission.count);
  if (mission.diagnostic?.state === "sessions_failing") return CONSOLE.commandCenter.degraded;
  return mission.diagnostic?.headline ?? CONSOLE.commandCenter.idle;
}

function emptyAgentLine(mission: MissionControlDto | null): string {
  if (mission?.diagnostic?.state === "sessions_failing") return CONSOLE.commandCenter.noAgents;
  return mission?.diagnostic?.detail ?? CONSOLE.commandCenter.noAgents;
}

function reliabilityLine(mission: MissionControlDto | null): string {
  const breakdown = mission?.failureBreakdown;
  if (!breakdown || breakdown.total === 0) return CONSOLE.commandCenter.reliabilityClear;
  return CONSOLE.commandCenter.reliability(
    percent(breakdown.failureRate),
    breakdown.dominantClass ?? CONSOLE.commandCenter.none,
  );
}

function presenceStyle(label: string, index: number): React.CSSProperties {
  return {
    ["--hue" as string]: agentColor(label),
    ["--presence-delay" as string]: `${index * 120}ms`,
  } as React.CSSProperties;
}

export function MissionCommandCenter({
  mission,
  founder,
  pendingCount,
  shippedCount,
  agentLabel,
}: MissionCommandCenterProps): React.JSX.Element {
  const sessions = mission?.sessions ?? [];
  return (
    <section className="missioncc" aria-label={CONSOLE.commandCenter.region}>
      <header className="missioncc__head">
        <div>
          <p className="missioncc__eyebrow">{CONSOLE.commandCenter.eyebrow}</p>
          <h2>{CONSOLE.commandCenter.title}</h2>
        </div>
        <span className={"missioncc__status" + (sessions.length > 0 ? " missioncc__status--live" : "")}>
          <i aria-hidden="true" />
          {statusLine(mission)}
        </span>
      </header>

      <dl className="missioncc__metrics">
        <div>
          <dt>{CONSOLE.commandCenter.metrics.throughput}</dt>
          <dd>{founder?.fleet.sessionsThisWindow ?? "--"}</dd>
        </div>
        <div>
          <dt>{CONSOLE.commandCenter.metrics.burn}</dt>
          <dd>{mission ? fmtCents(mission.totalEstimatedCostCents) : "--"}</dd>
        </div>
        <div>
          <dt>{CONSOLE.commandCenter.metrics.decisions}</dt>
          <dd>{pendingCount}</dd>
        </div>
        <div>
          <dt>{CONSOLE.commandCenter.metrics.outcomes}</dt>
          <dd>{shippedCount}</dd>
        </div>
      </dl>

      {sessions.length > 0 && (
        <div className="missioncc__presence" role="region" aria-label={CONSOLE.commandCenter.presenceRegion}>
          {sessions.map((session, index) => {
            const label = agentLabel(session.agentMemberId);
            return (
              <span
                key={session.id}
                className="missioncc__presence-agent"
                style={presenceStyle(label, index)}
                aria-label={`${label} ${session.agentStatus}`}
              >
                <i aria-hidden="true" />
                <b aria-hidden="true">{label.slice(0, 1).toUpperCase()}</b>
              </span>
            );
          })}
        </div>
      )}

      <div className="missioncc__body">
        <section className="missioncc__agents" aria-label={CONSOLE.commandCenter.agentsRegion}>
          {sessions.length === 0 ? (
            <p className="missioncc__empty">{emptyAgentLine(mission)}</p>
          ) : (
            <ul>
              {sessions.map((session) => (
                <li key={session.id}>
                  <span className="missioncc__agent">
                    <strong>{agentLabel(session.agentMemberId)}</strong>
                    <small>{session.agentStatus}</small>
                  </span>
                  <span>{fmtElapsed(session.elapsedMs)}</span>
                  <span>{fmtCents(session.estimatedCostCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <aside className="missioncc__reliability" aria-label={CONSOLE.commandCenter.reliabilityRegion}>
          <span>{CONSOLE.commandCenter.reliabilityTitle}</span>
          <strong>{reliabilityLine(mission)}</strong>
          {founder?.attention.required && founder.attention.reasons.length > 0 ? (
            <p>{founder.attention.reasons[0]}</p>
          ) : (
            <p>{CONSOLE.commandCenter.clear}</p>
          )}
        </aside>
      </div>
    </section>
  );
}
