/**
 * Connect Slack settings panel (#170) — container. Fetches the workspace's Slack connection state and
 * wires connect/disconnect to the API, rendering the pure {@link SlackConnect} component. Mirrors
 * {@link ConnectClaudePanel} (#68) — kept separate from the store (a view-local settings concern) so
 * the component stays unit-tested in isolation.
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { SlackStatus } from "../api/types.js";
import { SLACK_CONNECT } from "../brand.js";
import { SlackConnect } from "./SlackConnect.js";

export function SlackConnectPanel(): React.JSX.Element {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getSlack()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ connected: false, fingerprint: null }));
    return () => {
      live = false;
    };
  }, []);

  async function run(action: () => Promise<SlackStatus>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch {
      setError(SLACK_CONNECT.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace__panel">
      <SlackConnect
        status={status}
        busy={busy}
        error={error}
        onConnect={(input) => void run(() => api.connectSlack(input))}
        onDisconnect={() => void run(() => api.disconnectSlack())}
      />
    </div>
  );
}
