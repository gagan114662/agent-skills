/**
 * Cloud-scale usage view (#71) — the container that fetches the current tenant's usage report and
 * renders the presentational {@link UsageDashboard}. Kept separate from the store (a polled, view-
 * local concern) so the dashboard stays a pure, unit-tested component.
 */
import { useEffect, useState } from "react";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import type { UsageReport } from "../api/types.js";
import { UsageDashboard } from "./UsageDashboard.js";

export function UsagePanel(): React.JSX.Element {
  const { identity } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [usage, setUsage] = useState<UsageReport | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void api
      .getScaleUsage(workspaceId)
      .then((report) => {
        if (live) setUsage(report);
      })
      .catch(() => {
        /* leave the loading state; a transient error self-heals on the next mount */
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  return (
    <div className="workspace__panel">
      <UsageDashboard usage={usage} />
    </div>
  );
}
