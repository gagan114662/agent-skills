/**
 * Connect Claude settings panel (#68, ADR-0068) — presentational.
 *
 * Lets the workspace owner connect THEIR OWN Claude subscription so the fleet agents run on it (never
 * a pooled platform key). The token field is masked and the stored token is never rendered back — the
 * panel only ever knows the connected/not-connected state + a non-reversible fingerprint.
 */
import { useState } from "react";

export interface ConnectClaudeStatus {
  connected: boolean;
  fingerprint: string | null;
  /** The owner-picked fleet model (#246); null/undefined ⇒ the deployment default. */
  model?: string | null;
}

export interface ConnectClaudeProps {
  /** Current credential state, or null while loading. */
  status: ConnectClaudeStatus | null;
  /** True while a connect/disconnect request is in flight. */
  busy?: boolean;
  /** A user-facing error from the last action, if any. */
  error?: string | null;
  onConnect: (token: string) => void;
  onDisconnect: () => void;
  /** The models the owner may pick (#246) + the deployment default. Empty ⇒ picker hidden. */
  models?: string[];
  /** The canonical default model id (shown as the "(default)" option). */
  defaultModel?: string;
  /** Persist the workspace's fleet model (null ⇒ clear → use the default). */
  onSelectModel?: (model: string | null) => void;
}

export function ConnectClaude(props: ConnectClaudeProps): React.JSX.Element {
  const { status, busy, error, onConnect, onDisconnect, models, defaultModel, onSelectModel } = props;
  const [token, setToken] = useState("");

  return (
    <div className="connect-claude">
      <h3>Connect Claude</h3>
      <p className="connect-claude__hint">
        Your fleet agents run on your own Claude subscription. Generate a token with{" "}
        <code>claude setup-token</code> and paste it below — it is stored encrypted and never shown again.
      </p>

      {status === null ? (
        <p className="connect-claude__status">Loading…</p>
      ) : status.connected ? (
        <div className="connect-claude__connected">
          <p className="connect-claude__status" role="status">
            ✅ Connected{status.fingerprint ? ` · ${status.fingerprint}` : ""}
          </p>
          {models && models.length > 0 && onSelectModel ? (
            <div className="connect-claude__model">
              <label htmlFor="claude-model">Model</label>
              <select
                id="claude-model"
                aria-label="Fleet model"
                disabled={busy}
                value={status.model ?? ""}
                onChange={(e) => onSelectModel(e.target.value === "" ? null : e.target.value)}
              >
                <option value="">
                  {defaultModel ? `Default (${defaultModel})` : "Default"}
                </option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === defaultModel ? " — recommended" : ""}
                  </option>
                ))}
              </select>
              <p className="connect-claude__hint">
                Your fleet runs on this model via your subscription. We check it works on your plan before saving.
              </p>
            </div>
          ) : null}
          <button type="button" disabled={busy} onClick={() => onDisconnect()}>
            Disconnect
          </button>
        </div>
      ) : (
        <div className="connect-claude__notconnected">
          <p className="connect-claude__status">Not connected</p>
          {/* #263: no free-text secret field by default — the manual token paste lives behind this
              collapsed disclosure. Claude has no in-app OAuth (the token comes from the CLI), so the
              advanced paste is the connect path, never shown until the owner opens it. */}
          <details className="connect-claude__advanced">
            <summary>Connect Claude (advanced — paste a setup token)</summary>
            <form
              className="connect-claude__form"
              onSubmit={(e) => {
                e.preventDefault();
                if (token.trim()) onConnect(token.trim());
              }}
            >
              <label htmlFor="claude-token">Claude token</label>
              <input
                id="claude-token"
                type="password"
                autoComplete="off"
                placeholder="sk-ant-oat-…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button type="submit" disabled={busy || !token.trim()}>
                Connect
              </button>
            </form>
          </details>
        </div>
      )}

      {error ? (
        <p className="connect-claude__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
