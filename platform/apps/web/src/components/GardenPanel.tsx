/**
 * Agent Garden settings panel container (#284) — owns the view-local fetch + mutation state and wraps the
 * pure {@link Garden} component. Mirrors ConnectionsPanel: a useEffect fetch with a safe empty fallback (the
 * panel never crashes the settings overlay), and a `run()` helper that performs an enable/disable then
 * renders the canonical surface the server returns.
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { GardenResponse } from "../api/types.js";
import { GARDEN } from "../brand.js";
import { Garden } from "./Garden.js";

const EMPTY: GardenResponse = { canManage: false, agents: [] };

export function GardenPanel(): React.JSX.Element {
  const [data, setData] = useState<GardenResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getGarden()
      .then((d) => live && setData(d))
      .catch(() => live && setData(EMPTY)); // never leave null on error; the overlay must not crash
    return () => {
      live = false;
    };
  }, []);

  async function run(action: () => Promise<GardenResponse>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setData(await action());
    } catch {
      setError(GARDEN.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace__panel">
      <Garden
        data={data}
        busy={busy}
        error={error}
        onEnable={(handle) => void run(() => api.enableGardenAgent(handle))}
        onDisable={(handle) => void run(() => api.disableGardenAgent(handle))}
      />
    </div>
  );
}
