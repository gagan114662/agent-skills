/** Detail pane for one approval request: its current state plus the audit timeline. Opened from a
 * queue row; rendered when the store has an `activeRequest`. */
import { useState, type MouseEvent } from "react";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { authorLabel } from "../../store/store.js";
import { popConfetti } from "../../lib/confetti.js";
import { AuditTimeline } from "./AuditTimeline.js";
import { approvalReview } from "./approval-review.js";

export function RequestDetail(): React.JSX.Element | null {
  const { approvals, directory, identity } = useAppState();
  const store = useStore();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const req = approvals.activeRequest;
  if (!req) return null;
  const request = req;

  const review = approvalReview(request);
  const canDecide =
    identity?.kind === "human" &&
    identity.memberId !== request.requesterMemberId &&
    request.status === "pending";

  async function approve(e: MouseEvent<HTMLButtonElement>): Promise<void> {
    const r = e.currentTarget.getBoundingClientRect();
    setBusy(true);
    try {
      await store.decideApprove(request.id);
      popConfetti(r.left + r.width / 2, r.top + r.height / 2);
    } finally {
      setBusy(false);
    }
  }

  async function submitReject(): Promise<void> {
    const note = reason.trim();
    if (!note) return;
    setBusy(true);
    try {
      await store.decideReject(request.id, note);
      setRejecting(false);
      setReason("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="request-detail" role="dialog" aria-labelledby="approval-request-detail-title">
      <header className="request-detail__head">
        <h3 id="approval-request-detail-title">{request.summary}</h3>
        <span className={`pill pill--${request.status}`} aria-label={`Status: ${request.status}`}>
          {request.status}
        </span>
        <button className="iconbtn" type="button" aria-label="Close approval request detail" onClick={() => store.closeRequest()}>
          ✕
        </button>
      </header>

      <dl className="request-detail__facts">
        <dt>Action</dt>
        <dd>{review.actionLabel}</dd>
        {request.amount !== null && (
          <>
            <dt>Amount</dt>
            <dd>${request.amount}</dd>
          </>
        )}
        <dt>Requested by</dt>
        <dd>{authorLabel(directory, request.requesterMemberId)}</dd>
        {request.decidedByMemberId && (
          <>
            <dt>Decided by</dt>
            <dd>{authorLabel(directory, request.decidedByMemberId)}</dd>
          </>
        )}
        {request.reason && (
          <>
            <dt>Reason</dt>
            <dd>{request.reason}</dd>
          </>
        )}
        {request.error && (
          <>
            <dt>Error</dt>
            <dd className="request-detail__error">{request.error}</dd>
          </>
        )}
      </dl>

      <section className="request-detail__preview" aria-label="Exactly what will ship">
        <p className="request-detail__eyebrow">Exactly what will ship</p>
        <h4>{review.previewTitle}</h4>
        <pre>{review.previewBody}</pre>
      </section>

      <section className="request-detail__decision" aria-label="Approval decision">
        <dl>
          <dt>What changes</dt>
          <dd>{review.consequence}</dd>
          <dt>Why</dt>
          <dd>{review.rationale}</dd>
          <dt>Receipt</dt>
          <dd>{review.receipt}</dd>
        </dl>
        {review.risk && <p className="request-detail__risk">{review.risk}</p>}
        {canDecide && (
          <div className="request-detail__actions">
            {rejecting ? (
              <form
                className="request-detail__reject"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitReject();
                }}
              >
                <textarea
                  autoFocus
                  className="request-detail__reason"
                  placeholder="What should change?"
                  aria-label="Steer reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn--danger"
                  disabled={busy || !reason.trim()}
                  aria-label={`Send steer for request: ${request.summary}`}
                >
                  Send steer
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setRejecting(false);
                    setReason("");
                  }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  aria-label={`Approve request: ${request.summary}`}
                  onClick={(e) => void approve(e)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  aria-label={`Steer request: ${request.summary}`}
                  onClick={() => setRejecting(true)}
                >
                  Steer
                </button>
              </>
            )}
          </div>
        )}
      </section>

      <h4 className="request-detail__audit-title">Audit trail</h4>
      <AuditTimeline events={approvals.activeEvents} />
    </aside>
  );
}
