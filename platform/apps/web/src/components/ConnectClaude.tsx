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
  /** The dev/admin model override, if any; null/undefined ⇒ the managed default. */
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
  /**
   * Reveal the advanced model override. The fleet runs on a managed, always-valid model chosen by ipop,
   * so there is NO model picker in the normal user flow. This is an admin/dev-only escape hatch (the
   * container only sets it for dev builds) — never shown to ordinary owners.
   */
  advanced?: boolean;
  /** The models the override may pick. Only consulted when {@link advanced} is set. */
  models?: string[];
  /** The managed default model id (shown as the "(managed default)" option). */
  defaultModel?: string;
  /** Persist the override model (null ⇒ clear → use the managed default). */
  onSelectModel?: (model: string | null) => void;
}

export function ConnectClaude(props: ConnectClaudeProps): React.JSX.Element {
  const { status, busy, error, onConnect, onDisconnect, advanced, models, defaultModel, onSelectModel } = props;
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
          <p className="connect-claude__hint connect-claude__managed">
            Your fleet runs on a managed model{defaultModel ? ` (${defaultModel})` : ""}, kept up to date by
            ipop — there’s nothing to choose.
          </p>
          {/* Advanced model override: admin/dev only. The fleet otherwise runs on the managed default, so
              there is NO model picker in the normal user flow. The container reveals this for dev builds. */}
          {advanced && models && models.length > 0 && onSelectModel ? (
            <details className="connect-claude__advanced">
              <summary>Advanced: override the model (dev)</summary>
              <div className="connect-claude__model">
                <label htmlFor="claude-model">Model override</label>
                <select
                  id="claude-model"
                  aria-label="Fleet model override"
                  disabled={busy}
                  value={status.model ?? ""}
                  onChange={(e) => onSelectModel(e.target.value === "" ? null : e.target.value)}
                >
                  <option value="">
                    {defaultModel ? `Managed default (${defaultModel})` : "Managed default"}
                  </option>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                      {m === defaultModel ? " — managed default" : ""}
                    </option>
                  ))}
                </select>
                <p className="connect-claude__hint">
                  Overrides the managed model for this workspace. Validated against the models known to
                  resolve on your plan before saving; leave on the managed default unless you know you need this.
                </p>
              </div>
            </details>
          ) : null}
          <button type="button" disabled={busy} onClick={() => onDisconnect()}>
            Disconnect
          </button>
        </div>
      ) : (
        <form
          className="connect-claude__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) onConnect(token.trim());
          }}
        >
          <p className="connect-claude__status">Not connected</p>
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
      )}

      {error ? (
        <p className="connect-claude__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
