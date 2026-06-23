/** The Approvals Panel: the human governance surface for #13. Two views — the review Queue and
 * Policy management — with a request detail pane (audit timeline) opened from a queue row. Loads
 * the queue + policies on mount; live pending updates arrive via the store's notification handler. */
import { useEffect, useState, type KeyboardEvent } from "react";
import type { ApprovalStatus } from "@reload/shared";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { ReviewQueue } from "./ReviewQueue.js";
import { PolicyManager } from "./PolicyManager.js";
import { RequestDetail } from "./RequestDetail.js";

export interface ApprovalsPanelProps {
  /** #462: the status the queue opens to — "pending" (default, the inbox) or "executed" (the decision log). */
  initialStatus?: ApprovalStatus;
}

export function ApprovalsPanel({ initialStatus }: ApprovalsPanelProps = {}): React.JSX.Element {
  const store = useStore();
  const { identity, approvals } = useAppState();
  const [view, setView] = useState<"queue" | "policies">("queue");
  const isHuman = identity?.kind === "human";
  const views: Array<"queue" | "policies"> = isHuman ? ["queue", "policies"] : ["queue"];

  useEffect(() => {
    void store.loadApprovals(initialStatus);
    void store.loadPolicies();
  }, [store, initialStatus]);

  function onViewKeyDown(e: KeyboardEvent<HTMLButtonElement>, current: "queue" | "policies"): void {
    const currentIndex = views.indexOf(current);
    const nextForKey: Record<string, number | undefined> = {
      ArrowRight: (currentIndex + 1) % views.length,
      ArrowDown: (currentIndex + 1) % views.length,
      ArrowLeft: (currentIndex - 1 + views.length) % views.length,
      ArrowUp: (currentIndex - 1 + views.length) % views.length,
      Home: 0,
      End: views.length - 1,
    };
    const nextIndex = nextForKey[e.key];
    if (nextIndex === undefined) return;
    e.preventDefault();
    const next = views[nextIndex];
    if (!next) return;
    setView(next);
    document.getElementById(`approvals-view-tab-${next}`)?.focus();
  }

  return (
    <section className="approvals" aria-label="Approvals">
      <header className="approvals__head">
        <h2>Approvals</h2>
        <nav className="approvals__views" role="tablist" aria-label="Approval workspace views">
          <button
            id="approvals-view-tab-queue"
            type="button"
            role="tab"
            className={`tab${view === "queue" ? " tab--active" : ""}`}
            aria-selected={view === "queue"}
            aria-controls="approvals-view-panel-queue"
            tabIndex={view === "queue" ? 0 : -1}
            onKeyDown={(e) => onViewKeyDown(e, "queue")}
            onClick={() => setView("queue")}
          >
            Queue
            {approvals.pendingCount > 0 && <span className="badge">{approvals.pendingCount}</span>}
          </button>
          {isHuman && (
            <button
              id="approvals-view-tab-policies"
              type="button"
              role="tab"
              className={`tab${view === "policies" ? " tab--active" : ""}`}
              aria-selected={view === "policies"}
              aria-controls="approvals-view-panel-policies"
              tabIndex={view === "policies" ? 0 : -1}
              onKeyDown={(e) => onViewKeyDown(e, "policies")}
              onClick={() => setView("policies")}
            >
              Policies
            </button>
          )}
        </nav>
      </header>

      <div className="approvals__body">
        <div
          id={`approvals-view-panel-${view}`}
          className="approvals__main"
          role="tabpanel"
          aria-labelledby={`approvals-view-tab-${view}`}
        >
          {view === "queue" ? <ReviewQueue /> : <PolicyManager />}
        </div>
        <RequestDetail />
      </div>
    </section>
  );
}
