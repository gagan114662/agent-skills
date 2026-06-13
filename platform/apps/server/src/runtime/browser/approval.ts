/**
 * The browser approval gate seam (#174, ADR-0174). A side-effectful browser step (a click that submits,
 * typing into a form) NEVER runs autonomously: the session asks this gate whether a human has approved
 * it through #13. The gate's job is to (a) report whether an approval already exists, and (b) when one
 * does not, ensure a pending `browser.action` request is on the review queue — so the agent's step
 * refuses, and a human can approve it later (the same approval-first model as ADR-0013 §3, where the
 * action re-checks at execution time). Keeping it a seam means the session is unit-tested with the
 * deterministic {@link pendingApprovalGate} / {@link autoApprovalGate}; production wires the real
 * #13 route + `approval_requests` lookup.
 */
import type { BrowserToolName } from "./tools.js";

export interface BrowserApprovalRequest {
  workspaceId: string;
  sessionId: string;
  tool: BrowserToolName;
  /** The URL the action targets (for the audit summary), or null. */
  target: string | null;
  /** A human-readable summary of the action awaiting approval (shown in the review queue). */
  summary: string;
}

export interface BrowserApprovalDecision {
  /** True iff a human has approved this action (the step may proceed). */
  approved: boolean;
  /** The #13 approval request id (pending or approved) — recorded on the receipt. */
  approvalRequestId: string;
  reason: string;
}

export interface BrowserApprovalGate {
  ensure(request: BrowserApprovalRequest): Promise<BrowserApprovalDecision>;
}

export interface RecordingApprovalGate extends BrowserApprovalGate {
  readonly requests: BrowserApprovalRequest[];
}

/**
 * The SAFE DEFAULT gate: every side-effectful step stays pending (refused). It records the request that
 * would have been submitted so a test can assert "a submit without approval refuses, and a #13 request
 * was raised". This is the production posture for a brand-new action until a human acts.
 */
export function pendingApprovalGate(): RecordingApprovalGate {
  const requests: BrowserApprovalRequest[] = [];
  let n = 0;
  return {
    requests,
    async ensure(request): Promise<BrowserApprovalDecision> {
      requests.push(request);
      n += 1;
      return {
        approved: false,
        approvalRequestId: `pending-${n}`,
        reason: "awaiting human approval (#13)",
      };
    },
  };
}

/** A gate that approves everything — ONLY for exercising the approved path in tests. Never a default. */
export function autoApprovalGate(): RecordingApprovalGate {
  const requests: BrowserApprovalRequest[] = [];
  let n = 0;
  return {
    requests,
    async ensure(request): Promise<BrowserApprovalDecision> {
      requests.push(request);
      n += 1;
      return { approved: true, approvalRequestId: `approved-${n}`, reason: "approved" };
    },
  };
}
