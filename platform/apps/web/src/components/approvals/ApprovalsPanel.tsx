/** The Approvals Panel: the human governance surface for #13. Two views — the review Queue and
 * Policy management — with a request detail pane (audit timeline) opened from a queue row. Loads
 * the queue + policies on mount; live pending updates arrive via the store's notification handler. */
import { useEffect, useState } from "react";
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

  useEffect(() => {
    void store.loadApprovals(initialStatus);
    void store.loadPolicies();
  }, [store, initialStatus]);

  return (
    <section className="approvals" aria-label="Approvals">
      <header className="approvals__head">
        <h2>Approvals</h2>
        <nav className="approvals__views">
          <button
            className={`tab${view === "queue" ? " tab--active" : ""}`}
            aria-pressed={view === "queue"}
            onClick={() => setView("queue")}
          >
            Queue
            {approvals.pendingCount > 0 && <span className="badge">{approvals.pendingCount}</span>}
          </button>
          {isHuman && (
            <button
              className={`tab${view === "policies" ? " tab--active" : ""}`}
              aria-pressed={view === "policies"}
              onClick={() => setView("policies")}
            >
              Policies
            </button>
          )}
        </nav>
      </header>

      <div className="approvals__body">
        <div className="approvals__main">
          {view === "queue" ? <ReviewQueue /> : <PolicyManager />}
        </div>
        <RequestDetail />
      </div>
    </section>
  );
}
