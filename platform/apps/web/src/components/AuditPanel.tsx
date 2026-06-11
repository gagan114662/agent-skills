/**
 * Audit trail surface (#147) — the append-only who/what/when/gated-by feed, read-only and tenant-scoped.
 * Polled + view-local, backed by existing rows (#13 approvals, #147 runs, #123 launches) merged on the
 * server. No new event store; this is a read model that can never drift from state.
 */
import { useEffect, useState } from "react";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import type { AuditEventDto } from "../api/types.js";

const SOURCE_LABEL: Record<AuditEventDto["source"], string> = {
  approval: "Approval",
  automation: "Automation",
  agent: "Agent",
};

export function AuditPanel(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [events, setEvents] = useState<AuditEventDto[]>([]);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void api
      .getAudit(workspaceId)
      .then((e) => live && setEvents(e))
      .catch(() => {
        /* transient; self-heals on next mount */
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  return (
    <div className="workspace__panel audit">
      <h2>Audit trail</h2>
      <p className="muted">Every gated action the fleet took — who, what, when, and what gated it.</p>
      <table className="audit__table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Gated by</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No audit events yet.
              </td>
            </tr>
          )}
          {events.map((e) => (
            <tr key={`${e.source}-${e.ref}`}>
              <td>{new Date(e.at).toLocaleString()}</td>
              <td>{e.actorLabel}</td>
              <td>
                <span className="badge">{SOURCE_LABEL[e.source]}</span> {e.summary}
              </td>
              <td>{e.gatedBy}</td>
              <td>{e.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
