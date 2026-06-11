/** One approval request in the review queue: summary, requester, action, amount, TTL, and — for a
 * human who is not the requester — Approve / Reject (reason required) controls (mirrors the server
 * `requireHuman` + self-approval guard; the server still enforces them, see ADR-0026). */
import { useState, type MouseEvent } from "react";
import type { ApprovalRequestDto } from "@reload/shared";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { authorLabel } from "../../store/store.js";
import { popConfetti } from "../../lib/confetti.js";
import { formatAge, formatTtl, isExpired } from "./ttl.js";

export function ReviewRow({
  request,
  now = Date.now(),
}: {
  request: ApprovalRequestDto;
  now?: number;
}): React.JSX.Element {
  const { identity, directory } = useAppState();
  const store = useStore();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const isHuman = identity?.kind === "human";
  const isOwn = identity?.memberId === request.requesterMemberId;
  const canDecide = isHuman && !isOwn && request.status === "pending";
  const ttl = formatTtl(request.expiresAt, now);

  async function approve(e: MouseEvent<HTMLButtonElement>): Promise<void> {
    const r = e.currentTarget.getBoundingClientRect();
    setBusy(true);
    await store.decideApprove(request.id);
    setBusy(false);
    // A green light earns a confetti pop at the button (#145 criterion #5).
    popConfetti(r.left + r.width / 2, r.top + r.height / 2);
  }

  async function submitReject(): Promise<void> {
    if (!reason.trim()) return;
    setBusy(true);
    await store.decideReject(request.id, reason.trim());
    setBusy(false);
    setRejecting(false);
    setReason("");
  }

  return (
    <li className="review-row" data-status={request.status}>
      <button
        className="review-row__main"
        onClick={() => void store.openRequest(request.id)}
        aria-label={`Open request: ${request.summary}`}
      >
        <span className="review-row__summary">{request.summary}</span>
        <span className="review-row__meta">
          <span className="review-row__action">{request.actionType}</span>
          {request.amount !== null && (
            <span className="review-row__amount">${request.amount}</span>
          )}
          <span className="review-row__by">by {authorLabel(directory, request.requesterMemberId)}</span>
          <span className="review-row__age">{formatAge(request.createdAt, now)}</span>
          {ttl && (
            <span className={`review-row__ttl${isExpired(request.expiresAt, now) ? " review-row__ttl--expired" : ""}`}>
              {ttl}
            </span>
          )}
        </span>
      </button>

      {canDecide && (
        <div className="review-row__actions">
          {rejecting ? (
            <form
              className="review-row__reject"
              onSubmit={(e) => {
                e.preventDefault();
                void submitReject();
              }}
            >
              <input
                autoFocus
                className="review-row__reason"
                placeholder="Reason (required)"
                aria-label="Rejection reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button type="submit" className="btn btn--danger" disabled={busy || !reason.trim()}>
                Confirm reject
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
              <button className="btn btn--primary" disabled={busy} onClick={(e) => void approve(e)}>
                Approve
              </button>
              <button className="btn btn--danger" disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
