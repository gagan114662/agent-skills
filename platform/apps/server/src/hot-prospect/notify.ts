/**
 * Notification seams for hot-prospect alerting (issue #622) — and the trust boundary that keeps every outbound
 * notification BEHIND the approval queue (ADR-0013 / the #670 action-gate pattern).
 *
 * Two seams, one rule:
 *
 *   - {@link ApprovalGate} — the service's ONLY outbound path. Firing an alert PARKS a pending approval
 *     (recorded-only; sends nothing). This is the chokepoint: no alert reaches a prospect or a channel without
 *     a human approving the parked request first.
 *   - {@link AlertNotifier} — the thing that actually delivers an approved alert to a route. The service NEVER
 *     calls this directly; only an approval (a human action) drives it. The default {@link RecordingNotifier}
 *     records and makes no external call, so CI/tests never emit a real notification.
 *
 * The default {@link RecordingApprovalGate} composes the two: it stores parked requests and only invokes the
 * notifier when `approve()` is called — exactly the recorded-only, no-money posture of the #356 oz-loops
 * `publish_proposal` proposals. Until a deployment binds a real #13 gate + a real notifier, nothing goes out.
 */

import type { HotProspectAlert, NotificationRoute } from "./types.js";

/** An outbound notification request: the alert and the routes it should reach once approved. */
export interface NotificationRequest {
  workspaceId: string;
  alert: HotProspectAlert;
  routes: NotificationRoute[];
}

/** The result of parking a notification: a pending approval id (the #13 request handle) and its status. */
export interface ParkedApproval {
  approvalRequestId: string;
  status: "pending";
}

/**
 * Parks an outbound notification as a PENDING approval — recorded-only, never sends. The service calls this
 * (and nothing else) when an alert fires, so the outbound action is gated on a human approval by construction.
 */
export interface ApprovalGate {
  requestNotification(req: NotificationRequest): Promise<ParkedApproval>;
}

/** A delivery receipt from the notifier — an internal record, NOT an external send unless a real notifier is bound. */
export interface NotificationReceipt {
  route: NotificationRoute;
  /** A stable, deterministic receipt id. */
  receiptId: string;
}

/**
 * Delivers an approved alert to a single route. The production binding (out of this module's scope, since it
 * would be app wiring) would post to the outreach agent's queue + the user's notification feed. The default
 * {@link RecordingNotifier} only records — no external IO.
 */
export interface AlertNotifier {
  deliver(route: NotificationRoute, req: NotificationRequest): Promise<NotificationReceipt>;
}

/** A parked request plus its lifecycle status, as held by the {@link RecordingApprovalGate}. */
export interface PendingNotification {
  approvalRequestId: string;
  status: "pending" | "approved" | "rejected";
  request: NotificationRequest;
}

/**
 * In-memory {@link AlertNotifier} that records deliveries instead of sending. Deterministic receipt ids
 * (`receipt-<n>`), so a test never depends on randomness. The default notifier everywhere until a real one is
 * bound — it is structurally incapable of an external call.
 */
export class RecordingNotifier implements AlertNotifier {
  readonly delivered: NotificationReceipt[] = [];
  private seq = 0;

  async deliver(route: NotificationRoute, _req: NotificationRequest): Promise<NotificationReceipt> {
    const receipt: NotificationReceipt = { route, receiptId: `receipt-${++this.seq}` };
    this.delivered.push(receipt);
    return receipt;
  }
}

/**
 * In-memory {@link ApprovalGate} that records parked notifications (recorded-only; spends/sends nothing) and
 * — crucially — only drives the notifier when {@link approve} is called. This makes the #622 trust boundary
 * testable: after a scan, `pending` holds the parked requests but `notifier.delivered` is still empty; the
 * notifier fires ONLY after an explicit approval. Deterministic ids (`appr-<n>`).
 */
export class RecordingApprovalGate implements ApprovalGate {
  readonly pending: PendingNotification[] = [];
  private seq = 0;

  constructor(private readonly notifier?: AlertNotifier) {}

  async requestNotification(req: NotificationRequest): Promise<ParkedApproval> {
    const approvalRequestId = `appr-${++this.seq}`;
    this.pending.push({ approvalRequestId, status: "pending", request: req });
    return { approvalRequestId, status: "pending" };
  }

  /** Look up a parked request by its approval id. */
  find(approvalRequestId: string): PendingNotification | undefined {
    return this.pending.find((p) => p.approvalRequestId === approvalRequestId);
  }

  /**
   * Simulate a human approving a parked notification: mark it approved and — only now — deliver it through the
   * notifier (if one is bound), returning the receipts. Idempotent on an already-approved request: re-approving
   * does not re-deliver. Returns `[]` for an unknown or rejected id.
   */
  async approve(approvalRequestId: string): Promise<NotificationReceipt[]> {
    const parked = this.find(approvalRequestId);
    if (!parked || parked.status !== "pending") return [];
    parked.status = "approved";
    if (!this.notifier) return [];
    const receipts: NotificationReceipt[] = [];
    for (const route of parked.request.routes) {
      receipts.push(await this.notifier.deliver(route, parked.request));
    }
    return receipts;
  }

  /** Simulate a human rejecting a parked notification — it is never delivered. */
  reject(approvalRequestId: string): void {
    const parked = this.find(approvalRequestId);
    if (parked && parked.status === "pending") parked.status = "rejected";
  }
}
