import type { FastifyBaseLogger } from "fastify";
import type { ApprovalRequest } from "../db/repositories/approvals.js";
import { listHumanReviewers } from "../db/repositories/approvals.js";
import { notify, type NotifyInput } from "../notifications/service.js";
import { recordAsyncSideEffectFailure } from "../observability/metrics.js";

export type ApprovalCompletionOutcome = "executed" | "failed" | "rejected";

interface ApprovalCompletionDeps {
  listHumanReviewers(workspaceId: string, exceptMemberId: string): Promise<string[]>;
  notify(log: FastifyBaseLogger, input: NotifyInput): Promise<unknown>;
  recordAsyncSideEffectFailure(name: string): void;
}

const defaultDeps: ApprovalCompletionDeps = {
  listHumanReviewers,
  notify,
  recordAsyncSideEffectFailure,
};

function approvalCompletionExcerpt(request: ApprovalRequest, outcome: ApprovalCompletionOutcome): string {
  const label = outcome === "executed" ? "completed" : outcome;
  return "Approval " + label + ": " + request.summary;
}

export async function broadcastApprovalCompletion(
  log: FastifyBaseLogger,
  request: ApprovalRequest,
  actorMemberId: string,
  outcome: ApprovalCompletionOutcome,
  deps: ApprovalCompletionDeps = defaultDeps,
): Promise<void> {
  const recipients = await deps.listHumanReviewers(request.workspaceId, actorMemberId);
  await Promise.all(
    recipients.map(async (recipientMemberId) => {
      try {
        await deps.notify(log, {
          workspaceId: request.workspaceId,
          recipientMemberId,
          type: "approval",
          actorMemberId,
          excerpt: approvalCompletionExcerpt(request, outcome),
        });
      } catch (err) {
        deps.recordAsyncSideEffectFailure("approval_completion_notification");
        log.error(
          { err, workspaceId: request.workspaceId, approvalRequestId: request.id, recipientMemberId, outcome },
          "approval completion notification failed after durable decision write",
        );
      }
    }),
  );
}
