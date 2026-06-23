/**
 * The Deploy tab (#73): pick an agent session, deploy its app to a live HTTPS URL in one click, watch
 * status + (redacted) logs stream live, open the live URL, and Redeploy / Rollback / Scale. Mirrors
 * the Run Panel's store-driven, channel-scoped shape — but a deployment is durable (persisted), so the
 * panel also shows the immutable deployment history (the backup set rollback re-promotes from).
 */
import { useEffect } from "react";
import type { DeploymentDto } from "@reload/shared";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { VOICE } from "../../brand.js";
import { CopyButton } from "../CopyButton.js";
import { EmptyState } from "../EmptyState.js";

export function DeployPanel(): React.JSX.Element {
  const { deploy, activeChannelId } = useAppState();
  const store = useStore();

  useEffect(() => {
    if (activeChannelId) void store.loadDeploy();
  }, [store, activeChannelId]);

  const activeSession = deploy.sessions.find((s) => s.id === deploy.activeSessionId) ?? null;

  return (
    <div className="deploy">
      <aside className="deploy__sidebar" aria-label="Sessions">
        <h3>Sessions</h3>
        {deploy.sessions.length === 0 ? (
          <EmptyState className="emptystate--compact">{VOICE.noSessions}</EmptyState>
        ) : (
          <ul>
            {deploy.sessions.map((s) => (
              <li key={s.id}>
                <button
                  className={`deploy__session${s.id === deploy.activeSessionId ? " deploy__session--active" : ""}`}
                  aria-pressed={s.id === deploy.activeSessionId}
                  onClick={() => void store.selectDeploySession(s.id)}
                >
                  <span className="deploy__session-branch">{s.branch ?? s.id.slice(0, 8)}</span>
                  <span className="deploy__session-status">{s.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="deploy__main">
        {deploy.error && (
          <p className="deploy__error" role="alert">
            {deploy.error}
          </p>
        )}
        {activeSession ? <DeployStage /> : <EmptyState>{VOICE.pickSessionToDeploy}</EmptyState>}
      </section>
    </div>
  );
}

function DeployStage(): React.JSX.Element {
  const { deploy } = useAppState();
  const store = useStore();
  const latest = deploy.latest;
  const status = latest?.status ?? "none";
  const live = latest?.status === "ready" || latest?.status === "rolled_back";
  const inFlight = deploy.busy || latest?.status === "building" || latest?.status === "queued";
  const canRollback = deploy.history.filter((d) => d.status === "ready" || d.status === "rolled_back").length > 1;

  return (
    <>
      <div className="deploy__controls">
        <span className={`deploy__status deploy__status--${status}`}>{status}</span>
        {latest?.url && live && (
          <a className="deploy__url" href={latest.url} target="_blank" rel="noreferrer">
            {latest.url}
          </a>
        )}
        <button className="btn btn--primary" disabled={inFlight} onClick={() => void store.deployApp()}>
          {inFlight ? "Deploying…" : latest ? "Redeploy" : "Deploy app"}
        </button>
        <button
          className="btn"
          disabled={inFlight || !canRollback}
          onClick={() => void store.rollbackDeploy()}
        >
          Rollback
        </button>
        <button
          className="btn btn--ghost"
          disabled={!live}
          onClick={() => void store.scaleDeploy(2)}
        >
          Scale ×2
        </button>
      </div>
      {latest?.error && (
        <p className="deploy__error" role="alert">
          {latest.error}
        </p>
      )}
      <DeployLogs logs={latest?.logs ?? []} />
      <DeployHistory history={deploy.history} />
    </>
  );
}

function DeployLogs({ logs }: { logs: string[] }): React.JSX.Element | null {
  if (logs.length === 0) return null;
  const text = logs.join("\n");
  return (
    <section className="copyblock">
      <div className="copyblock__head">
        <span>Deploy logs</span>
        <CopyButton text={text} />
      </div>
      <pre className="deploy__logs" aria-label="Deploy logs">
        {text}
      </pre>
    </section>
  );
}

function DeployHistory({ history }: { history: DeploymentDto[] }): React.JSX.Element | null {
  if (history.length === 0) return null;
  return (
    <div className="deploy__history">
      <h4>Deployments</h4>
      <ul>
        {history.map((d) => (
          <li key={d.id} className="deploy__history-row">
            <span className={`deploy__status deploy__status--${d.status}`}>{d.status}</span>
            {d.url ? (
              <a href={d.url} target="_blank" rel="noreferrer">
                {d.url}
              </a>
            ) : (
              <span className="deploy__history-pending">—</span>
            )}
            <span className="deploy__history-reason">{d.reason ?? "deploy"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
