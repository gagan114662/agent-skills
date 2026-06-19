/**
 * Live mission control (#147) — the workspace's running agent sessions with status, elapsed, an
 * estimated spend, and steer/stop controls. Spend is an estimate from elapsed × the tenant compute rate
 * (the platform records no per-session cost). Steer + stop are tenant-scoped and best-effort.
 *
 * #362: the session list is now driven by live websocket events via {@link useLiveMissionControl} — a new
 * agent message / handoff / session lifecycle change refreshes the strip within the socket round-trip, with a
 * poll FALLBACK that degrades to the prior 4s cadence when the socket is unavailable (never worse than today).
 */
import { useState } from "react";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import { useLiveMissionControl } from "./console/useLiveMissionControl.js";

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m ${s % 60}s`;
}

function fmtCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

export function MissionControlPanel(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  // #362: live websocket-driven mission control, with a poll fallback (see useLiveMissionControl).
  const { data: mc, refresh } = useLiveMissionControl(workspaceId);
  const [steerFor, setSteerFor] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");

  async function stop(id: string): Promise<void> {
    if (!workspaceId) return;
    await api.missionControl.stop(workspaceId, id);
    await refresh();
  }

  async function sendSteer(id: string): Promise<void> {
    if (!workspaceId || !guidance.trim()) return;
    await api.missionControl.steer(workspaceId, id, guidance.trim());
    setSteerFor(null);
    setGuidance("");
  }

  return (
    <div className="workspace__panel mission">
      <h2>Mission control</h2>
      <p className="muted">
        {mc ? `${mc.count} running · ~${fmtCents(mc.totalEstimatedCostCents)} (estimated)` : "Loading…"}
      </p>
      <table className="mission__table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Status</th>
            <th>Elapsed</th>
            <th>Est. spend</th>
            <th>Controls</th>
          </tr>
        </thead>
        <tbody>
          {mc && mc.sessions.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No running sessions.
              </td>
            </tr>
          )}
          {mc?.sessions.map((s) => (
            <tr key={s.id}>
              <td>
                <code>{s.id.slice(0, 8)}</code>
              </td>
              <td>
                <span className="badge">{s.status}</span>
              </td>
              <td>{fmtElapsed(s.elapsedMs)}</td>
              <td>{fmtCents(s.estimatedCostCents)}</td>
              <td className="mission__controls">
                {steerFor === s.id ? (
                  <>
                    <input
                      value={guidance}
                      placeholder="Steer guidance…"
                      onChange={(e) => setGuidance(e.target.value)}
                      aria-label="steer guidance"
                    />
                    <button className="btn btn--ghost" onClick={() => void sendSteer(s.id)}>
                      Send
                    </button>
                    <button className="btn btn--ghost" onClick={() => setSteerFor(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn btn--ghost" onClick={() => setSteerFor(s.id)}>
                      Steer
                    </button>
                    <button className="btn btn--ghost" onClick={() => void stop(s.id)}>
                      Stop
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
