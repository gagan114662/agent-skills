/**
 * Connect external accounts settings panel (#192/#231) — presentational.
 *
 * The owner connects the venture-operating accounts the fleet acts THROUGH — a hosting/publish account,
 * an email-sending domain/ESP, analytics, ads, payments. Human-once: paste the key, and the agents use
 * it forever. The panel shows exactly what's still NEEDED before a venture can do real work, what's
 * already connected, and a connect form. Secrets are masked and never rendered back. All copy comes from
 * `brand.ts` `EXTERNAL_ACCOUNTS` (house rule: no hardcoded strings in product chrome).
 */
import { useState } from "react";
import { EXTERNAL_ACCOUNTS } from "../brand.js";
import type { ExternalAccountsChecklist, RealworldReadiness } from "../api/types.js";

export interface ExternalAccountsConnect {
  serviceKey: string;
  serviceKind: string;
  displayName: string;
  secret: string;
}

export interface ExternalAccountsProps {
  /** The onboarding checklist, or null while loading. */
  checklist: ExternalAccountsChecklist | null;
  /** External account KINDS the owner must still connect before a venture can do real work (#231). */
  needed: string[];
  /** Publish provider status from /me/realworld, so dry-run is explicit (#872). */
  publishStatus?: RealworldReadiness["publish"] | null;
  busy?: boolean;
  error?: string | null;
  onConnect: (input: ExternalAccountsConnect) => void;
  onDisconnect: (serviceKey: string) => void;
}

const KIND_OPTIONS = Object.keys(EXTERNAL_ACCOUNTS.kinds);

function kindLabel(kind: string): string {
  return EXTERNAL_ACCOUNTS.kinds[kind] ?? kind;
}

export function ExternalAccounts(props: ExternalAccountsProps): React.JSX.Element {
  const { checklist, needed, publishStatus, busy, error, onConnect, onDisconnect } = props;
  const [serviceKind, setServiceKind] = useState<string>(KIND_OPTIONS[0] ?? "other");
  const [serviceKey, setServiceKey] = useState("");
  const [secret, setSecret] = useState("");
  const ready = serviceKey.trim().length > 0 && secret.trim().length > 0;

  return (
    <div className="connect-accounts">
      <h3>{EXTERNAL_ACCOUNTS.title}</h3>
      <p className="connect-accounts__hint">{EXTERNAL_ACCOUNTS.hint}</p>

      {checklist === null ? (
        <p className="connect-accounts__status">{EXTERNAL_ACCOUNTS.loading}</p>
      ) : (
        <>
          {needed.length > 0 ? (
            <div className="connect-accounts__needed" role="status">
              <p>{EXTERNAL_ACCOUNTS.neededTitle}</p>
              <ul>
                {needed.map((kind) => (
                  <li key={kind}>{kindLabel(kind)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="connect-accounts__status" role="status">
              ✅ {EXTERNAL_ACCOUNTS.allConnected}
            </p>
          )}

          {publishStatus?.dryRun ? (
            <div className="connect-accounts__needed" role="status">
              <p>{EXTERNAL_ACCOUNTS.dryRunTitle}</p>
              <p>{EXTERNAL_ACCOUNTS.dryRunBody}</p>
            </div>
          ) : null}

          {checklist.requests.length === 0 ? (
            <p className="connect-accounts__empty">{EXTERNAL_ACCOUNTS.noneYet}</p>
          ) : (
            <ul className="connect-accounts__list">
              {checklist.requests.map((r) => (
                <li key={r.serviceKey} className="connect-accounts__item">
                  <span className="connect-accounts__name">
                    {r.displayName} · {kindLabel(r.serviceKind)}
                  </span>
                  <span className="connect-accounts__badge">
                    {r.connected ? EXTERNAL_ACCOUNTS.connectedBadge : EXTERNAL_ACCOUNTS.pendingBadge}
                  </span>
                  {r.connected ? (
                    <button type="button" disabled={busy} onClick={() => onDisconnect(r.serviceKey)}>
                      {EXTERNAL_ACCOUNTS.disconnect}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {/* #263: no free-text secret field by default — the manual key/token paste lives behind this
              collapsed disclosure. The default connect surface is the OAuth-first Connections panel. */}
          <details className="connect-accounts__advanced">
            <summary>{EXTERNAL_ACCOUNTS.advancedSummary}</summary>
            <form
              className="connect-accounts__form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!ready) return;
                onConnect({
                  serviceKind,
                  serviceKey: serviceKey.trim(),
                  displayName: `${kindLabel(serviceKind)} (${serviceKey.trim()})`,
                  secret: secret.trim(),
                });
                setSecret("");
              }}
            >
            <label htmlFor="account-kind">{EXTERNAL_ACCOUNTS.kindLabel}</label>
            <select
              id="account-kind"
              value={serviceKind}
              onChange={(e) => setServiceKind(e.target.value)}
            >
              {KIND_OPTIONS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(kind)}
                </option>
              ))}
            </select>
            <label htmlFor="account-key">{EXTERNAL_ACCOUNTS.keyLabel}</label>
            <input
              id="account-key"
              type="text"
              autoComplete="off"
              placeholder={EXTERNAL_ACCOUNTS.keyPlaceholder}
              value={serviceKey}
              onChange={(e) => setServiceKey(e.target.value)}
            />
            <label htmlFor="account-secret">{EXTERNAL_ACCOUNTS.secretLabel}</label>
            <input
              id="account-secret"
              type="password"
              autoComplete="off"
              placeholder={EXTERNAL_ACCOUNTS.secretPlaceholder}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
              <button type="submit" disabled={busy || !ready}>
                {EXTERNAL_ACCOUNTS.connect}
              </button>
            </form>
          </details>
        </>
      )}

      {error ? (
        <p className="connect-accounts__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
