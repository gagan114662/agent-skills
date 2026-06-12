/**
 * Founder Console (#104) container — fetches the current tenant's read-only roll-up and renders the
 * presentational {@link FounderDashboard}. Kept separate from the store (a polled, view-local concern)
 * so the dashboard stays a pure, unit-tested component — the #71 UsagePanel pattern.
 */
import { useEffect, useState } from "react";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import type {
  DailyBriefDto,
  DecisionQueueDto,
  FounderConsoleDto,
  WeeklyReportDto,
} from "../api/types.js";
import { FounderDashboard } from "./FounderDashboard.js";
import { BriefingsPanel } from "./BriefingsPanel.js";

export function FounderPanel(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [console, setConsole] = useState<FounderConsoleDto | null>(null);
  const [daily, setDaily] = useState<DailyBriefDto | null>(null);
  const [weekly, setWeekly] = useState<WeeklyReportDto | null>(null);
  const [decisionQueue, setDecisionQueue] = useState<DecisionQueueDto | null>(null);
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
    // #173 founder briefings: the same data the company pushes to the owner, rendered in the console.
    void api.getFounderBriefingDaily(workspaceId).then((d) => live && setDaily(d)).catch(() => {});
    void api.getFounderBriefingWeekly(workspaceId).then((w) => live && setWeekly(w)).catch(() => {});
    void api
      .getFounderDecisionQueue(workspaceId)
      .then((q) => live && setDecisionQueue(q))
      .catch(() => {});
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
      <BriefingsPanel daily={daily} decisionQueue={decisionQueue} weekly={weekly} />
    </div>
  );
}
