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

  return (
    <div className="workspace__panel">
      <FounderDashboard console={console} />
    </div>
  );
}
