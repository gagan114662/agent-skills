/**
 * Settings → Spend Cap panel (#670) — container. Fetches the workspace's global spend-cap status + pending
 * cap-raises and renders the pure {@link BudgetSettings} summary, wiring its action callbacks to
 * `api.budget`. Kept separate from the store — a view-local settings concern — mirroring
 * {@link BillingSettingsPanel}.
 *
 * When the governor is disabled the read answers 409; the panel treats that as "off" and renders the off
 * note rather than an error. All mutations refetch the status so the summary and pending list stay current.
 */
import { useCallback, useEffect, useState } from "react";
import type { BudgetStatusDto, CapRaiseDto } from "../api/types.js";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import { BudgetSettings } from "./BudgetSettings.js";

export function BudgetSettingsPanel(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<BudgetStatusDto | null>(null);
  const [pendingRaises, setPendingRaises] = useState<CapRaiseDto[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await api.budget.status(workspaceId);
      setEnabled(res.enabled);
      setStatus(res.status);
      setPendingRaises(res.pendingRaises);
    } catch {
      // 409 (disabled) or transient failure: leave the panel on its off/empty default and self-heal next open.
      setEnabled(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Run a mutation, then refetch — best-effort so a transient failure can't wedge the panel busy. */
  const run = useCallback(
    async (op: () => Promise<unknown>) => {
      if (!workspaceId || busy) return;
      setBusy(true);
      try {
        await op();
      } catch {
        // surfaced on the refetched state; nothing to do here
      } finally {
        await refresh();
        setBusy(false);
      }
    },
    [workspaceId, busy, refresh],
  );

  return (
    <BudgetSettings
      enabled={enabled}
      status={status}
      pendingRaises={pendingRaises}
      busy={busy}
      onRequestRaise={(toCents) => void run(() => api.budget.requestRaise(workspaceId!, toCents))}
      onLower={(toCents) => void run(() => api.budget.lower(workspaceId!, toCents))}
      onApprove={(raiseId) => void run(() => api.budget.approveRaise(workspaceId!, raiseId))}
      onReject={(raiseId) => void run(() => api.budget.rejectRaise(workspaceId!, raiseId))}
    />
  );
}
