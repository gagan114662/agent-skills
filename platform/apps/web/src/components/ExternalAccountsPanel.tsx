/**
 * Connect external accounts settings panel (#192/#231) — container. Fetches the onboarding checklist +
 * the real-world readiness (what to connect before a venture can do real work) and wires connect /
 * disconnect to the API, rendering the pure {@link ExternalAccounts} component. Mirrors
 * {@link SlackConnectPanel} — view-local (not in the store) so it stays unit-tested in isolation.
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { ExternalAccountsChecklist } from "../api/types.js";
import { EXTERNAL_ACCOUNTS } from "../brand.js";
import { ExternalAccounts, type ExternalAccountsConnect } from "./ExternalAccounts.js";

export function ExternalAccountsPanel(): React.JSX.Element {
  const [checklist, setChecklist] = useState<ExternalAccountsChecklist | null>(null);
  const [needed, setNeeded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getExternalAccounts()
      .then((c) => live && setChecklist(c))
      .catch(() => live && setChecklist({ requests: [], pendingSetupCount: 0 }));
    void api
      .getRealworldReadiness()
      .then((r) => live && setNeeded(r.neededAccounts))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  async function run(action: () => Promise<ExternalAccountsChecklist>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setChecklist(await action());
      // Connection state changed — refresh what's still needed for real work.
      const readiness = await api.getRealworldReadiness().catch(() => null);
      if (readiness) setNeeded(readiness.neededAccounts);
    } catch {
      setError(EXTERNAL_ACCOUNTS.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace__panel">
      <ExternalAccounts
        checklist={checklist}
        needed={needed}
        busy={busy}
        error={error}
        onConnect={(input: ExternalAccountsConnect) =>
          void run(() =>
            api.connectExternalAccount({
              serviceKey: input.serviceKey,
              serviceKind: input.serviceKind,
              displayName: input.displayName,
              secrets: { API_KEY: input.secret },
            }),
          )
        }
        onDisconnect={(serviceKey) => void run(() => api.disconnectExternalAccount(serviceKey))}
      />
    </div>
  );
}
