/**
 * Connect Claude settings panel (#68) — container. Fetches the workspace's credential state and wires
 * connect/disconnect to the API, rendering the pure {@link ConnectClaude} component. Kept separate
 * from the store (a view-local settings concern) so the component stays unit-tested in isolation.
 *
 * #246: also fetches the selectable fleet models + wires the owner model picker. The picker is
 * validated server-side against the models known to resolve on the subscription, so an unservable id
 * (the `claude-fable-5` class) can never be saved — the fix surfaces an error instead of crashing
 * every session mid-run.
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { CredentialStatus } from "../api/types.js";
import { ConnectClaude } from "./ConnectClaude.js";

export function ConnectClaudePanel(): React.JSX.Element {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getAgentCredentials()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ connected: false, fingerprint: null }));
    void api
      .getAgentModels()
      .then((m) => {
        if (!live) return;
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {
        /* picker stays hidden if the model list can't load — connect/disconnect still work */
      });
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
        models={models}
        defaultModel={defaultModel}
        onConnect={(token) => void run(() => api.connectAgentCredentials(token))}
        onDisconnect={() => void run(() => api.disconnectAgentCredentials())}
        onSelectModel={(model) => void run(() => api.setAgentModel(model))}
      />
    </div>
  );
}
