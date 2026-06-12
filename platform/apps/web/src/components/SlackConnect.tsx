/**
 * Connect Slack settings panel (#170, ADR-0170) — presentational.
 *
 * Lets the workspace owner connect their Slack app so the fleet works inside their Slack. The bot
 * token + signing secret fields are masked and the stored secrets are never rendered back — the panel
 * only ever knows the connected/not-connected state + a non-reversible fingerprint. All copy comes from
 * `brand.ts` `SLACK_CONNECT` (house rule: no hardcoded strings in product chrome).
 */
import { useState } from "react";
import { SLACK_CONNECT } from "../brand.js";

export interface SlackConnectStatus {
  connected: boolean;
  fingerprint: string | null;
}

export interface SlackConnectProps {
  /** Current connection state, or null while loading. */
  status: SlackConnectStatus | null;
  /** True while a connect/disconnect request is in flight. */
  busy?: boolean;
  /** A user-facing error from the last action, if any. */
  error?: string | null;
  onConnect: (input: { botToken: string; signingSecret: string }) => void;
  onDisconnect: () => void;
}

export function SlackConnect(props: SlackConnectProps): React.JSX.Element {
  const { status, busy, error, onConnect, onDisconnect } = props;
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const ready = botToken.trim().length > 0 && signingSecret.trim().length > 0;

  return (
    <div className="connect-slack">
      <h3>{SLACK_CONNECT.title}</h3>
      <p className="connect-slack__hint">{SLACK_CONNECT.hint}</p>

      {status === null ? (
        <p className="connect-slack__status">{SLACK_CONNECT.loading}</p>
      ) : status.connected ? (
        <div className="connect-slack__connected">
          <p className="connect-slack__status" role="status">
            ✅ {SLACK_CONNECT.connected}
            {status.fingerprint ? ` · ${status.fingerprint}` : ""}
          </p>
          <button type="button" disabled={busy} onClick={() => onDisconnect()}>
            {SLACK_CONNECT.disconnect}
          </button>
        </div>
      ) : (
        <form
          className="connect-slack__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) onConnect({ botToken: botToken.trim(), signingSecret: signingSecret.trim() });
          }}
        >
          <p className="connect-slack__status">{SLACK_CONNECT.notConnected}</p>
          <label htmlFor="slack-bot-token">{SLACK_CONNECT.botTokenLabel}</label>
          <input
            id="slack-bot-token"
            type="password"
            autoComplete="off"
            placeholder={SLACK_CONNECT.botTokenPlaceholder}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
          />
          <label htmlFor="slack-signing-secret">{SLACK_CONNECT.signingSecretLabel}</label>
          <input
            id="slack-signing-secret"
            type="password"
            autoComplete="off"
            placeholder={SLACK_CONNECT.signingSecretPlaceholder}
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
          />
          <button type="submit" disabled={busy || !ready}>
            {SLACK_CONNECT.connect}
          </button>
        </form>
      )}

      {error ? (
        <p className="connect-slack__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
