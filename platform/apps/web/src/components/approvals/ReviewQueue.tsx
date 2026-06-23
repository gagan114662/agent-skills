/** The review queue: status tabs over the workspace's approval requests, each row decidable by a
 * human (see ReviewRow). Reads the approvals slice; tab clicks re-query the server by status. */
import type { ApprovalStatus } from "@reload/shared";
import type { KeyboardEvent } from "react";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { VOICE } from "../../brand.js";
import { EmptyState } from "../EmptyState.js";
import { PopLoader } from "../PopLoader.js";
import { ReviewRow } from "./ReviewRow.js";

const TABS: { key: ApprovalStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "executed", label: "Executed" },
  { key: "rejected", label: "Rejected" },
  { key: "expired", label: "Expired" },
];

export function ReviewQueue(): React.JSX.Element {
  const { approvals } = useAppState();
  const store = useStore();

  function onStatusKeyDown(e: KeyboardEvent<HTMLButtonElement>, current: ApprovalStatus): void {
    const currentIndex = TABS.findIndex((t) => t.key === current);
    const nextForKey: Record<string, number | undefined> = {
      ArrowRight: (currentIndex + 1) % TABS.length,
      ArrowDown: (currentIndex + 1) % TABS.length,
      ArrowLeft: (currentIndex - 1 + TABS.length) % TABS.length,
      ArrowUp: (currentIndex - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    const nextIndex = nextForKey[e.key];
    if (nextIndex === undefined) return;
    e.preventDefault();
    const next = TABS[nextIndex]?.key;
    if (!next) return;
    void store.loadApprovals(next);
    document.getElementById(`approval-status-tab-${next}`)?.focus();
  }

  return (
    <div className="review-queue">
      <nav className="review-queue__tabs" role="tablist" aria-label="Approval status">
        {TABS.map((t) => (
          <button
            key={t.key}
            id={`approval-status-tab-${t.key}`}
            type="button"
            role="tab"
            className={`tab${approvals.status === t.key ? " tab--active" : ""}`}
            aria-selected={approvals.status === t.key}
            aria-controls="approval-status-panel"
            tabIndex={approvals.status === t.key ? 0 : -1}
            onKeyDown={(e) => onStatusKeyDown(e, t.key)}
            onClick={() => void store.loadApprovals(t.key)}
          >
            {t.label}
            {t.key === "pending" && approvals.pendingCount > 0 && (
              <span className="badge">{approvals.pendingCount}</span>
            )}
          </button>
        ))}
      </nav>

      {approvals.error && (
        <p className="review-queue__error" role="alert">
          {approvals.error}
        </p>
      )}

      <div id="approval-status-panel" role="tabpanel" aria-labelledby={`approval-status-tab-${approvals.status}`}>
        {approvals.loading ? (
          <PopLoader label={`Loading ${approvals.status} requests…`} />
        ) : approvals.requests.length === 0 ? (
          <EmptyState>{VOICE.emptyApprovals}</EmptyState>
        ) : (
          <ul className="review-queue__list" aria-label={`${approvals.status} approval requests`}>
            {approvals.requests.map((r) => (
              <ReviewRow key={r.id} request={r} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
