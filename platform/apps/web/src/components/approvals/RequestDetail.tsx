/** Detail pane for one approval request: its current state plus the audit timeline. Opened from a
 * queue row; rendered when the store has an `activeRequest`. */
import { useAppState, useStore } from "../../store/StoreContext.js";
import { authorLabel } from "../../store/store.js";
import { AuditTimeline } from "./AuditTimeline.js";

export function RequestDetail(): React.JSX.Element | null {
  const { approvals, directory } = useAppState();
  const store = useStore();
  const req = approvals.activeRequest;
  if (!req) return null;

  return (
    <aside className="request-detail" role="dialog" aria-labelledby="approval-request-detail-title">
      <header className="request-detail__head">
        <h3 id="approval-request-detail-title">{req.summary}</h3>
        <span className={`pill pill--${req.status}`} aria-label={`Status: ${req.status}`}>
          {req.status}
        </span>
        <button className="iconbtn" type="button" aria-label="Close approval request detail" onClick={() => store.closeRequest()}>
          ✕
        </button>
      </header>

      <dl className="request-detail__facts">
        <dt>Action</dt>
        <dd>{req.actionType}</dd>
        {req.amount !== null && (
          <>
            <dt>Amount</dt>
            <dd>${req.amount}</dd>
          </>
        )}
        <dt>Requested by</dt>
        <dd>{authorLabel(directory, req.requesterMemberId)}</dd>
        {req.decidedByMemberId && (
          <>
            <dt>Decided by</dt>
            <dd>{authorLabel(directory, req.decidedByMemberId)}</dd>
          </>
        )}
        {req.reason && (
          <>
            <dt>Reason</dt>
            <dd>{req.reason}</dd>
          </>
        )}
        {req.error && (
          <>
            <dt>Error</dt>
            <dd className="request-detail__error">{req.error}</dd>
          </>
        )}
      </dl>

      <h4 className="request-detail__audit-title">Audit trail</h4>
      <AuditTimeline events={approvals.activeEvents} />
    </aside>
  );
}
