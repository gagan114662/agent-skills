/** Detail pane for one approval request: its current state plus the audit timeline. Opened from a
 * queue row; rendered when the store has an `activeRequest`. */
import { useEffect, useState, type MouseEvent } from "react";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { authorLabel } from "../../store/store.js";
import { popConfetti } from "../../lib/confetti.js";
import { AuditTimeline } from "./AuditTimeline.js";
import { approvalReview, type ApprovalDraftPreview } from "./approval-review.js";

function rollbackMetadata(result: Record<string, unknown> | null): {
  label: string;
  status: string;
  url: string | null;
} | null {
  const raw = result?.rollback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rollback = raw as Record<string, unknown>;
  const label = typeof rollback.label === "string" ? rollback.label : "Rollback";
  const status = typeof rollback.status === "string" ? rollback.status : null;
  const url = typeof rollback.url === "string" && rollback.url.length > 0 ? rollback.url : null;
  return status ? { label, status, url } : null;
}

function DraftCard({ draft }: { draft: ApprovalDraftPreview }): React.JSX.Element {
  return (
    <article className={`channel-draft channel-draft--${draft.format}`}>
      <header className="channel-draft__head">
        <span className="channel-draft__format">{draft.label}</span>
        <h5>{draft.title}</h5>
      </header>
      <dl className="channel-draft__fields">
        {draft.sections.map((section) => (
          <div key={section.label} className="channel-draft__field">
            <dt>{section.label}</dt>
            <dd>{section.value}</dd>
          </div>
        ))}
      </dl>
      {draft.citations.length > 0 && (
        <p className="channel-draft__citations">Cites {draft.citations.slice(0, 3).join("; ")}</p>
      )}
    </article>
  );
}

function DraftPreview({ drafts, fallback }: { drafts: ApprovalDraftPreview[]; fallback: string }): React.JSX.Element {
  if (drafts.length === 0) return <pre>{fallback}</pre>;
  return (
    <div className="request-detail__drafts">
      {drafts.map((draft) => (
        <DraftCard key={`${draft.format}:${draft.title}`} draft={draft} />
      ))}
    </div>
  );
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasEdit(original: string, next: string): boolean {
  return normalized(original) !== normalized(next);
}

function DraftDiff({ original, edited }: { original: string; edited: string }): React.JSX.Element | null {
  if (!hasEdit(original, edited)) return null;
  return (
    <div className="draft-diff" aria-label="Draft diff">
      <div className="draft-diff__pane draft-diff__pane--old">
        <span>Original</span>
        <p>{original}</p>
      </div>
      <div className="draft-diff__pane draft-diff__pane--new">
        <span>Edited</span>
        <p>{edited}</p>
      </div>
    </div>
  );
}

export function RequestDetail(): React.JSX.Element | null {
  const { approvals, directory, identity } = useAppState();
  const store = useStore();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [editValue, setEditValue] = useState("");
  const req = approvals.activeRequest;
  const request = req;

  const review = request ? approvalReview(request) : null;
  const editable = review?.editable ?? null;
  useEffect(() => {
    setRejecting(false);
    setReason("");
    setEditValue(editable?.value ?? "");
  }, [request?.id, editable?.field, editable?.value]);

  if (!request || !review) return null;
  const requestId = request.id;
  const rollback = rollbackMetadata(request.result);
  const canDecide =
    identity?.kind === "human" &&
    identity.memberId !== request.requesterMemberId &&
    request.status === "pending";

  async function approve(e: MouseEvent<HTMLButtonElement>): Promise<void> {
    const r = e.currentTarget.getBoundingClientRect();
    setBusy(true);
    try {
      const edit = editable && (editable.synthetic || hasEdit(editable.value, editValue))
        ? { field: editable.field, value: editValue.trim() }
        : undefined;
      await store.decideApprove(requestId, undefined, edit);
      popConfetti(r.left + r.width / 2, r.top + r.height / 2);
    } finally {
      setBusy(false);
    }
  }

  async function submitRequestChanges(): Promise<void> {
    const note = reason.trim();
    if (!note) return;
    setBusy(true);
    try {
      await store.decideRequestChanges(requestId, note);
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
        {rollback && (
          <>
            <dt>Rollback</dt>
            <dd className="request-detail__rollback">
              <strong>{rollback.label}</strong>
              <span>{rollback.status}</span>
              {rollback.url && (
                <a href={rollback.url} target="_blank" rel="noreferrer">
                  Open rollback
                </a>
              )}
            </dd>
          </>
        )}
      </dl>

      <section className="request-detail__preview" aria-label="Exactly what will ship">
        <p className="request-detail__eyebrow">Exactly what will ship</p>
        <h4>{review.previewTitle}</h4>
        <DraftPreview drafts={review.drafts} fallback={review.previewBody} />
      </section>

      {canDecide && editable && (
        <section className="request-detail__edit" aria-label="Inline edit">
          <label htmlFor={`approval-edit-${request.id}`}>Inline edit</label>
          <textarea
            id={`approval-edit-${request.id}`}
            className="request-detail__editbox"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            aria-label={`Edit ${editable.label.toLowerCase()}`}
          />
          <DraftDiff original={editable.value} edited={editValue} />
        </section>
      )}

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
                  void submitRequestChanges();
                }}
              >
                <textarea
                  autoFocus
                  className="request-detail__reason"
                  placeholder="What should change?"
                  aria-label="Request changes note"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn--danger"
                  disabled={busy || !reason.trim()}
                  aria-label={`Send request changes for request: ${request.summary}`}
                >
                  Send to Quill
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
                  disabled={busy || (!!editable && editValue.trim().length === 0)}
                  aria-label={`Approve request: ${request.summary}`}
                  onClick={(e) => void approve(e)}
                >
                  {editable && hasEdit(editable.value, editValue)
                    ? "Approve edited draft"
                    : review.drafts.length > 1
                      ? "Approve all drafts"
                      : "Approve"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  aria-label={`Request changes for request: ${request.summary}`}
                  onClick={() => setRejecting(true)}
                >
                  Request changes
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
