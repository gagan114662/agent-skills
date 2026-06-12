/**
 * Founder Console (#104) container — fetches the current tenant's read-only roll-up and renders the
 * presentational {@link FounderDashboard}. Kept separate from the store (a polled, view-local concern)
 * so the dashboard stays a pure, unit-tested component — the #71 UsagePanel pattern.
 */
import { useEffect, useState } from "react";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import type { FounderConsoleDto } from "../api/types.js";
import { FounderDashboard } from "./FounderDashboard.js";

export function FounderPanel(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [console, setConsole] = useState<FounderConsoleDto | null>(null);
  const [switchBusy, setSwitchBusy] = useState<{ kill?: boolean; maintenance?: boolean }>({});
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void api
      .getFounderConsole(workspaceId)
      .then((data) => {
        if (live) setConsole(data);
      })
      .catch(() => {
        /* leave the loading state; a transient error self-heals on the next mount */
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  /**
   * Optimistic toggle: flip the displayed switch immediately, call the real (human-gated) endpoint, then
   * reconcile with the server's truth — or revert + surface a friendly error if it fails. This is the only
   * mutation the Founder Console performs; both endpoints are workspace-scoped and human-only server-side,
   * and neither touches the #13 approval gates (#169 bug 12).
   */
  async function toggleKillSwitch(next: boolean): Promise<void> {
    if (!workspaceId || !console) return;
    const prev = console;
    setSwitchError(null);
    setSwitchBusy((b) => ({ ...b, kill: true }));
    setConsole({ ...console, switches: { ...console.switches, killSwitch: next } });
    try {
      const res = await api.setKillSwitch(workspaceId, next);
      setConsole((c) =>
        c ? { ...c, switches: { ...c.switches, killSwitch: res.killSwitch } } : c,
      );
    } catch {
      setConsole(prev);
      setSwitchError("Couldn't update the kill switch. Please try again.");
    } finally {
      setSwitchBusy((b) => ({ ...b, kill: false }));
    }
  }

  async function toggleMaintenance(next: boolean): Promise<void> {
    if (!workspaceId || !console) return;
    const prev = console;
    setSwitchError(null);
    setSwitchBusy((b) => ({ ...b, maintenance: true }));
    setConsole({
      ...console,
      switches: {
        ...console.switches,
        maintenance: { ...console.switches.maintenance, enabled: next },
      },
    });
    try {
      const res = await api.setMaintenance(next);
      setConsole((c) => (c ? { ...c, switches: { ...c.switches, maintenance: res } } : c));
    } catch {
      setConsole(prev);
      setSwitchError("Couldn't update maintenance mode. Please try again.");
    } finally {
      setSwitchBusy((b) => ({ ...b, maintenance: false }));
    }
  }

  return (
    <div className="workspace__panel">
      <FounderDashboard
        console={console}
        onToggleKillSwitch={(next) => void toggleKillSwitch(next)}
        onToggleMaintenance={(next) => void toggleMaintenance(next)}
        switchBusy={switchBusy}
        switchError={switchError}
      />
    </div>
  );
}
