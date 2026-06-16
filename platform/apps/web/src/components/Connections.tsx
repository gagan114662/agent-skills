/**
 * Connections settings panel (#258) — presentational. The OAuth-first "connect once, the agents do the
 * rest" surface. Customers are non-technical, so customer connectors are consumer OAuth ("Sign in with
 * Google", "Connect X") rendered as one-click buttons; connectors whose live flow isn't wired yet are
 * honestly disabled ("Coming soon"). The GitHub site-publish connector is admin-only — its paste form is
 * rendered ONLY when the server says this workspace manages internal connections, and never to a customer.
 *
 * Connector labels + summaries come from the server registry (data); only the chrome copy lives in
 * brand.ts CONNECTIONS (house rule: no hardcoded brand strings in product chrome).
 */
import { useState } from "react";
import { CONNECTIONS } from "../brand.js";
import type { ConnectionsResponse, ConnectionView } from "../api/types.js";

export interface ConnectionsProps {
  data: ConnectionsResponse | null;
  busy?: boolean;
  error?: string | null;
  onOAuthConnect: (id: string) => void;
  onInternalConnect: (id: string, input: { repo: string; token: string; baseBranch: string }) => void;
  onDisconnect: (id: string) => void;
}

export function Connections(props: ConnectionsProps): React.JSX.Element {
  const { data, busy, error, onOAuthConnect, onInternalConnect, onDisconnect } = props;

  if (data === null) {
    return (
      <div className="connections">
        <h3>{CONNECTIONS.title}</h3>
        <p className="connections__status">{CONNECTIONS.loading}</p>
      </div>
    );
  }

  const customer = data.connections.filter((c) => c.audience === "customer");
  const internal = data.connections.filter((c) => c.audience === "internal");

  return (
    <div className="connections">
      <h3>{CONNECTIONS.title}</h3>
      <p className="connections__hint">{CONNECTIONS.hint}</p>

      <ul className="connections__list">
        {customer.map((c) => (
          <li key={c.id} className="connections__item">
            <span className="connections__summary">{c.summary}</span>
            <CustomerAction connection={c} busy={busy} onConnect={onOAuthConnect} onDisconnect={onDisconnect} />
          </li>
        ))}
      </ul>

      {data.canManageInternal
        ? internal.map((c) => (
            <InternalConnect key={c.id} connection={c} busy={busy} onConnect={onInternalConnect} onDisconnect={onDisconnect} />
          ))
        : null}

      {error ? (
        <p className="connections__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CustomerAction(props: {
  connection: ConnectionView;
  busy?: boolean;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}): React.JSX.Element {
  const { connection: c, busy, onConnect, onDisconnect } = props;
  if (c.connected) {
    return (
      <span className="connections__connected">
        <span className="connections__badge">{CONNECTIONS.connectedBadge}</span>
        <button type="button" disabled={busy} onClick={() => onDisconnect(c.id)}>
          {CONNECTIONS.disconnect}
        </button>
      </span>
    );
  }
  const comingSoon = c.status === "coming_soon";
  return (
    <span className="connections__action">
      <button type="button" disabled={busy || comingSoon} onClick={() => onConnect(c.id)}>
        {c.label}
      </button>
      {comingSoon ? <span className="connections__soon">{CONNECTIONS.comingSoon}</span> : null}
    </span>
  );
}

function InternalConnect(props: {
  connection: ConnectionView;
  busy?: boolean;
  onConnect: (id: string, input: { repo: string; token: string; baseBranch: string }) => void;
  onDisconnect: (id: string) => void;
}): React.JSX.Element {
  const { connection: c, busy, onConnect, onDisconnect } = props;
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const ready = repo.trim().length > 0 && token.trim().length > 0;
  const repoId = `${c.id}-repo`;
  const branchId = `${c.id}-branch`;
  const tokenId = `${c.id}-token`;

  return (
    <section className="connections__internal">
      <h4>{c.label}</h4>
      <p className="connections__hint">{CONNECTIONS.internalHint}</p>
      {c.connected ? (
        // Connected — show the badge + disconnect only (no free-text fields), matching ConnectClaude/Slack.
        <p className="connections__connected">
          <span className="connections__badge">{CONNECTIONS.connectedBadge}</span>
          <button type="button" disabled={busy} onClick={() => onDisconnect(c.id)}>
            {CONNECTIONS.disconnect}
          </button>
        </p>
      ) : (
        <form
          className="connections__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            onConnect(c.id, { repo: repo.trim(), token: token.trim(), baseBranch: baseBranch.trim() });
            setToken("");
          }}
        >
          <label htmlFor={repoId}>{CONNECTIONS.repoLabel}</label>
          <input
            id={repoId}
            type="text"
            autoComplete="off"
            placeholder={CONNECTIONS.repoPlaceholder}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <label htmlFor={branchId}>{CONNECTIONS.branchLabel}</label>
          <input
            id={branchId}
            type="text"
            autoComplete="off"
            placeholder={CONNECTIONS.branchPlaceholder}
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
          />
          <label htmlFor={tokenId}>{CONNECTIONS.tokenLabel}</label>
          <input
            id={tokenId}
            type="password"
            autoComplete="off"
            placeholder={CONNECTIONS.tokenPlaceholder}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit" disabled={busy || !ready}>
            {CONNECTIONS.internalConnect}
          </button>
        </form>
      )}
    </section>
  );
}
