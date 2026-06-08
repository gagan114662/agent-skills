/** The review queue: status tabs over the workspace's approval requests, each row decidable by a
 * human (see ReviewRow). Reads the approvals slice; tab clicks re-query the server by status. */
import type { ApprovalStatus } from "@reload/shared";
import { useAppState, useStore } from "../../store/StoreContext.js";
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

  return (
    <div className="review-queue">
      <nav className="review-queue__tabs" aria-label="Approval status">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab${approvals.status === t.key ? " tab--active" : ""}`}
            aria-pressed={approvals.status === t.key}
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

      {approvals.loading ? (
        <p className="review-queue__empty">Loading…</p>
      ) : approvals.requests.length === 0 ? (
        <p className="review-queue__empty">No {approvals.status} requests.</p>
      ) : (
        <ul className="review-queue__list">
          {approvals.requests.map((r) => (
            <ReviewRow key={r.id} request={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
