/**
 * The production browser approval gate (#174, ADR-0174) — the seam from {@link BrowserApprovalGate} to
 * the real #13 system, with the IO kept behind {@link BrowserApprovalStore} so the ensure() logic is
 * unit-tested without a DB. The model (ADR-0013 §3, approval-first):
 *
 *   1. a human has ALREADY approved this exact action (session + tool + target) → `approved` (proceed);
 *   2. else a pending request already exists for it → `pending` (refuse, no duplicate raised);
 *   3. else create a pending `browser.action` request → `pending` (refuse; a human can now act).
 *
 * The "exact action" key is (sessionId, tool, target): the agent re-runs the same step after approval
 * and finds the approval, so a single human decision unlocks exactly that one mutation — not a blanket
 * "browser can now do anything". The DB store implementation lives in `db/repositories`.
 */
import type {
  BrowserApprovalDecision,
  BrowserApprovalGate,
  BrowserApprovalRequest,
} from "./approval.js";

/** A prior #13 request matching one browser action, reduced to the id the receipt records. */
export interface MatchedApproval {
  approvalRequestId: string;
}

/** The IO seam the gate needs: look up a prior decision, or raise a new pending request. */
export interface BrowserApprovalStore {
  /** A previously-APPROVED (or executed) request for this exact action, or null. */
  findApproved(key: BrowserApprovalKey): Promise<MatchedApproval | null>;
  /** An already-PENDING request for this exact action (so we don't raise a duplicate), or null. */
  findPending(key: BrowserApprovalKey): Promise<MatchedApproval | null>;
  /** Raise a new pending `browser.action` request through #13. Returns the new request id. */
  createPending(request: BrowserApprovalRequest): Promise<MatchedApproval>;
}

export interface BrowserApprovalKey {
  workspaceId: string;
  sessionId: string;
  tool: string;
  target: string | null;
}

function keyOf(request: BrowserApprovalRequest): BrowserApprovalKey {
  return {
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    tool: request.tool,
    target: request.target,
  };
}

/** Build the store-backed gate. Pure orchestration over the injected store (no IO of its own). */
export function storeBackedApprovalGate(store: BrowserApprovalStore): BrowserApprovalGate {
  return {
    async ensure(request): Promise<BrowserApprovalDecision> {
      const key = keyOf(request);
      const approved = await store.findApproved(key);
      if (approved) {
        return { approved: true, approvalRequestId: approved.approvalRequestId, reason: "approved by a human (#13)" };
      }
      const pending = await store.findPending(key);
      if (pending) {
        return { approved: false, approvalRequestId: pending.approvalRequestId, reason: "awaiting human approval (#13)" };
      }
      const created = await store.createPending(request);
      return { approved: false, approvalRequestId: created.approvalRequestId, reason: "submitted for approval (#13)" };
    },
  };
}
