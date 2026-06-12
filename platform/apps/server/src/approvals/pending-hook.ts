import type { FastifyBaseLogger } from "fastify";
import type { ApprovalRequest } from "../db/repositories/approvals.js";

/**
 * A post-time hook fired when an action goes **pending** (#170). Registered once at boot by the Slack
 * bridge so a pending approval can be DMed to the owner with Approve/Reject buttons — WITHOUT touching
 * the #13 gate itself. Module-level + best-effort, mirroring the #123 `setMarketingMentionTrigger` seam:
 * the approval route fires it after it has already created the pending request and notified the
 * in-app reviewers, so a Slack failure can never affect the gate or the write that already succeeded.
 */
export type ApprovalPendingHook = (request: ApprovalRequest) => Promise<void>;

let hook: ApprovalPendingHook | undefined;

/** Register (or clear, with `undefined`) the approval-pending hook. Called from `buildApp`. */
export function setApprovalPendingHook(fn: ApprovalPendingHook | undefined): void {
  hook = fn;
}

/** Run the registered hook for a just-created pending request, best-effort. No-op when unset. */
export async function fireApprovalPending(
  log: FastifyBaseLogger,
  request: ApprovalRequest,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(request);
  } catch (err) {
    log.error({ err }, "approval pending Slack hook failed");
  }
}
