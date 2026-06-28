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
  /** Turn on a one-click live channel (e.g. outbound email) — no redirect, no pasted secret (#529/#507). */
  onOneClickConnect: (id: string) => void;
  /** Join the waitlist for a connector that isn't live yet — a next step instead of a dead stop (#507). */
  onWaitlist: (id: string) => void;
  onInternalConnect: (id: string, input: { repo: string; token: string; baseBranch: string }) => void;
  onDisconnect: (id: string) => void;
}

export function Connections(props: ConnectionsProps): React.JSX.Element {
  const { data, busy, error, onOAuthConnect, onOneClickConnect, onWaitlist, onInternalConnect, onDisconnect } = props;

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
            <ConfigIssueNotice connection={c} />
            <CapabilityProof connection={c} />
            <CustomerAction
              connection={c}
              busy={busy}
              onOAuthConnect={onOAuthConnect}
              onOneClickConnect={onOneClickConnect}
              onWaitlist={onWaitlist}
              onDisconnect={onDisconnect}
            />
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

function capabilityLabel(capability: string): string {
  return capability.replace(/[_-]+/g, " ");
}

function ConfigIssueNotice({ connection }: { connection: ConnectionView }): React.JSX.Element | null {
  if (!connection.configIssue) return null;
  if (connection.status === "coming_soon") return null;
  return (
    <span className="connections__config" role="status">
      <span>{connection.configIssue.remedy}</span>
      <span className="connections__config-missing">
        {connection.configIssue.missingEnv.join(", ")}
      </span>
    </span>
  );
}

function CapabilityProof({ connection }: { connection: ConnectionView }): React.JSX.Element | null {
  if (connection.capabilities.length === 0) return null;
  const title = connection.connected ? CONNECTIONS.unlocks : CONNECTIONS.lockedUntilConnected;
  return (
    <span className="connections__capabilities" aria-label={title + ": " + connection.label}>
      <span className="connections__capabilities-title">{title}</span>
      <span className="connections__chips">
        {connection.capabilities.map((capability) => (
          <span
            key={capability}
            className={connection.connected ? "connections__chip connections__chip--on" : "connections__chip"}
          >
            {capabilityLabel(capability)}
          </span>
        ))}
      </span>
    </span>
  );
}

function CustomerAction(props: {
  connection: ConnectionView;
  busy?: boolean;
  onOAuthConnect: (id: string) => void;
  onOneClickConnect: (id: string) => void;
  onWaitlist: (id: string) => void;
  onDisconnect: (id: string) => void;
}): React.JSX.Element {
  const { connection: c, busy, onOAuthConnect, onOneClickConnect, onWaitlist, onDisconnect } = props;
  const [waitlisted, setWaitlisted] = useState(false);
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
  if (c.consentStatus === "recorded" && c.providerStatus !== "healthy") {
    return (
      <span className="connections__connected">
        <span className="connections__badge">{CONNECTIONS.proofPendingBadge}</span>
        <span className="connections__soon" role="status">
          {c.failureReason ?? CONNECTIONS.proofPendingDetail}
        </span>
        <button type="button" disabled={busy} onClick={() => onDisconnect(c.id)}>
          {CONNECTIONS.disconnect}
        </button>
      </span>
    );
  }
  if (c.status === "blocked") {
    return (
      <span className="connections__action">
        <span className="connections__label">{c.label}</span>
        <span className="connections__soon">{CONNECTIONS.blocked}</span>
        {c.statusReason ? <span className="connections__reason">{c.statusReason}</span> : null}
        <button type="button" disabled>
          {c.label}
        </button>
      </span>
    );
  }
  // Not live yet: a clear next step (join the waitlist) instead of a dead, disabled "Coming soon" button.
  if (c.status === "coming_soon") {
    const detail = c.configIssue
      ? c.configIssue.remedy + " Missing: " + c.configIssue.missingEnv.join(", ") + "."
      : null;
    if (waitlisted) {
      return (
        <span className="connections__soon" role="status">
          {CONNECTIONS.waitlisted}
        </span>
      );
    }
    return (
      <span className="connections__action">
        <span className="connections__label">{c.label}</span>
        <span className="connections__soon">{detail ?? CONNECTIONS.comingSoon}</span>
        <button
          type="button"
          className="connections__waitlist"
          disabled={busy}
          onClick={() => {
            onWaitlist(c.id);
            setWaitlisted(true);
          }}
        >
          {CONNECTIONS.waitlist}
        </button>
      </span>
    );
  }
  // Live: one-click connectors (e.g. outbound email) turn on without a redirect; the rest start consumer OAuth.
  const onConnect = c.auth === "one_click" ? onOneClickConnect : onOAuthConnect;
  return (
    <span className="connections__action">
      <button type="button" disabled={busy} onClick={() => onConnect(c.id)}>
        {c.label}
      </button>
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
          // #477: Chrome ignores input-level autoComplete="off" and will autofill a saved EMAIL into the
          // first text field it guesses (the base-branch input got an account email). A form-level "off" plus
          // non-semantic field names (not "branch"/"email") + data-1p/lp-ignore reliably stops the misfire.
          autoComplete="off"
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
            name="site-repo-nofill"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            placeholder={CONNECTIONS.repoPlaceholder}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <label htmlFor={branchId}>{CONNECTIONS.branchLabel}</label>
          <input
            id={branchId}
            type="text"
            name="site-base-branch-nofill"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
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
