/**
 * Connect Claude settings panel (#68) — container. Fetches the workspace's credential state and wires
 * connect/disconnect to the API, rendering the pure {@link ConnectClaude} component. Kept separate
 * from the store (a view-local settings concern) so the component stays unit-tested in isolation.
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { CredentialStatus } from "../api/types.js";
import { ConnectClaude } from "./ConnectClaude.js";

export function ConnectClaudePanel(): React.JSX.Element {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getAgentCredentials()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ connected: false, fingerprint: null }));
    return () => {
      live = false;
    };
  }, []);

  async function run(action: () => Promise<CredentialStatus>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch {
      setError("Couldn't update your Claude connection. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace__panel">
      <ConnectClaude
        status={status}
        busy={busy}
        error={error}
        onConnect={(token) => void run(() => api.connectAgentCredentials(token))}
        onDisconnect={() => void run(() => api.disconnectAgentCredentials())}
      />
    </div>
  );
}
