/**
 * Connect Claude settings panel (#68) — container. Fetches the workspace's credential state and wires
 * connect/disconnect to the API, rendering the pure {@link ConnectClaude} component. Kept separate
 * from the store (a view-local settings concern) so the component stays unit-tested in isolation.
 *
 * The fleet runs on a managed, always-valid model chosen by ipop, so there is NO model picker in the
 * normal user flow. An advanced override remains for dev/admin builds only (revealed via `advanced`,
 * which the container sets from `import.meta.env.DEV`); the selectable models are only fetched then. The
 * override is still validated server-side against the models known to resolve, so an unservable id can
 * never be saved — but even if a bad value slipped through, the runtime self-heals to the managed default.
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { CredentialStatus, ClaudeConnectOffer } from "../api/types.js";
import { ConnectClaude } from "./ConnectClaude.js";

/** Advanced model override is dev/admin only — never in the normal production user flow. */
const ADVANCED_MODEL_OVERRIDE = import.meta.env.DEV;

export function ConnectClaudePanel(): React.JSX.Element {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [offer, setOffer] = useState<ClaudeConnectOffer | undefined>(undefined);
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
    // #262: which connect method to feature (managed one-click vs the Advanced paste). The paste path
    // always works regardless, so a failed offer fetch just leaves the panel on today's behavior.
    void api
      .getClaudeConnectOffer()
      .then((o) => live && setOffer(o.offer))
      .catch(() => {
        /* leave offer undefined → paste-first */
      });
    // The managed default is fetched only for the advanced (dev) override — ordinary users never pick a model.
    if (ADVANCED_MODEL_OVERRIDE) {
      void api
        .getAgentModels()
        .then((m) => {
          if (!live) return;
          setModels(m.models);
          setDefaultModel(m.default);
        })
        .catch(() => {
          /* override stays hidden if the model list can't load — connect/disconnect still work */
        });
    }
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

  // #262: begin the managed one-click flow — get the consent URL and hand off to it. The token is sealed
  // server-side on the callback; on return the panel re-mounts and re-reads the connected state.
  async function startManagedConnect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.startClaudeConnect();
      window.location.assign(authorizeUrl);
    } catch {
      setError("Couldn't start the Claude connection. You can paste a setup token under Advanced.");
      setBusy(false);
    }
  }

  return (
    <div className="workspace__panel">
      <ConnectClaude
        status={status}
        busy={busy}
        error={error}
        offer={offer}
        advanced={ADVANCED_MODEL_OVERRIDE}
        models={models}
        defaultModel={defaultModel}
        onConnect={(token) => void run(() => api.connectAgentCredentials(token))}
        onDisconnect={() => void run(() => api.disconnectAgentCredentials())}
        onStartManagedConnect={() => void startManagedConnect()}
        onSelectModel={(model) => void run(() => api.setAgentModel(model))}
      />
    </div>
  );
}
