import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../index.js";
import { approvalRequests } from "../schema/index.js";
import { createRequest } from "./approvals.js";
import { loadEnv } from "../../env.js";
import type { ApprovalStatus } from "../../approvals/policy.js";
import type {
  BrowserApprovalKey,
  BrowserApprovalStore,
  MatchedApproval,
} from "../../runtime/browser/approval-default.js";
import type { BrowserApprovalRequest } from "../../runtime/browser/approval.js";

/**
 * The DB-backed browser approval store (#174, ADR-0174) — implements the {@link BrowserApprovalStore}
 * seam over the real #13 `approval_requests` table. A browser action is matched by its exact key
 * (sessionId + tool + target) inside the `browser.action` payload, so one human decision unlocks exactly
 * that one mutation. `createPending` goes through the same `createRequest` the #13 route uses, so the
 * action lands on the review queue with a full audit trail. `requesterMemberId` is the agent member
 * driving the browser (supplied when the gate is built for a session).
 */
const APPROVED_STATUSES: readonly ApprovalStatus[] = ["approved", "executed"];

function matches(payload: Record<string, unknown>, key: BrowserApprovalKey): boolean {
  const target = typeof payload.target === "string" ? payload.target : null;
  return (
    payload.sessionId === key.sessionId &&
    payload.tool === key.tool &&
    target === key.target
  );
}

export function dbBrowserApprovalStore(requesterMemberId: string): BrowserApprovalStore {
  async function findByStatus(
    key: BrowserApprovalKey,
    statuses: readonly ApprovalStatus[],
  ): Promise<MatchedApproval | null> {
    const rows = await db
      .select({ id: approvalRequests.id, payload: approvalRequests.payload, status: approvalRequests.status })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.workspaceId, key.workspaceId),
          eq(approvalRequests.actionType, "browser.action"),
          inArray(approvalRequests.status, statuses as ApprovalStatus[]),
        ),
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(50);
    const hit = rows.find((r) => matches((r.payload ?? {}) as Record<string, unknown>, key));
    return hit ? { approvalRequestId: hit.id } : null;
  }

  return {
    findApproved: (key) => findByStatus(key, APPROVED_STATUSES),
    findPending: (key) => findByStatus(key, ["pending"]),
    async createPending(request: BrowserApprovalRequest): Promise<MatchedApproval> {
      const ttlSeconds = loadEnv().approval.defaultTtlSeconds;
      const payload: Record<string, unknown> = {
        sessionId: request.sessionId,
        tool: request.tool,
        summary: request.summary,
      };
      if (request.target !== null) payload.target = request.target;
      const created = await createRequest({
        workspaceId: request.workspaceId,
        requesterMemberId,
        actionType: "browser.action",
        payload,
        amount: null,
        summary: request.summary,
        status: "pending",
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        events: [{ type: "requested", detail: { reason: "browser action requires approval (#174)" } }],
      });
      return { approvalRequestId: created.id };
    },
  };
}
