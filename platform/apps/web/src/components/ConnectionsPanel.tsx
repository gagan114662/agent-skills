/**
 * Connections settings panel (#258) — container. Fetches the OAuth-first connections surface and wires
 * OAuth-connect / internal-paste-connect / disconnect to the API, rendering the pure {@link Connections}
 * component. View-local (not in the store) so it stays unit-tested in isolation, mirroring
 * {@link ExternalAccountsPanel}.
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { ConnectionsResponse } from "../api/types.js";
import { CONNECTIONS } from "../brand.js";
import { Connections } from "./Connections.js";

export function ConnectionsPanel(): React.JSX.Element {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getConnections()
      .then((d) => live && setData(d))
      .catch(() => live && setData({ connections: [], canManageInternal: false }));
    return () => {
      live = false;
    };
  }, []);

  async function run(action: () => Promise<ConnectionsResponse>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setData(await action());
    } catch {
      setError(CONNECTIONS.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace__panel">
      <Connections
        data={data}
        busy={busy}
        error={error}
        onOAuthConnect={(id) =>
          // The consumer-OAuth redirect is a follow-up; the server replies "coming soon" today.
          void run(async () => {
            await api.startConnectionOAuth(id).catch(() => undefined);
            return api.getConnections();
          })
        }
        // One-click live channel (e.g. outbound email): turns on without a redirect or a pasted secret (#529/#507).
        onOneClickConnect={(id) => void run(() => api.enableConnection(id))}
        // Not live yet: record interest so the user has a next step. Failures stay quiet — the UI already
        // optimistically confirms, and a waitlist join is non-critical.
        onWaitlist={(id) => void api.joinConnectionWaitlist(id).catch(() => undefined)}
        onInternalConnect={(id, input) => void run(() => api.connectInternal(id, input))}
        onDisconnect={(id) => void run(() => api.disconnectConnection(id))}
      />
    </div>
  );
}
