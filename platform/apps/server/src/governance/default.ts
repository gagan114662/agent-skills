/**
 * Production wiring for the #13 ApprovalService (ADR-0013): the persistence store over the
 * approvals repository, an executor that makes an authorization observable in-product, and a
 * notifier that fans an `approval` notification (#8) out to the workspace's human approvers.
 */
import type { FastifyBaseLogger } from "fastify";
import {
  createApprovalRequest,
  getApprovalRequest,
  getGovernancePolicy,
  recordExecution,
  resolvePendingRequest,
  type ApprovalRequest,
} from "../db/repositories/approvals.js";
import { listWorkspaceMembersByKind } from "../db/repositories/members.js";
import { postMessage } from "../db/repositories/messages.js";
import { publishMessageEvent } from "../realtime/bus.js";
import { notify } from "../notifications/service.js";
import { ApprovalService, type ApprovalExecutor, type ApprovalNotifier, type ApprovalStore } from "./service.js";

/** Repository-backed store (exported so integration tests reuse real persistence). */
export const dbApprovalStore: ApprovalStore = {
  create: createApprovalRequest,
  getById: getApprovalRequest,
  resolvePending: resolvePendingRequest,
  recordExecution,
  getPolicy: getGovernancePolicy,
};

/**
 * Default executor: when the authorized action names a channel, post a confirmation into it AS the
 * requester (reusing the #5 publish-on-write path) so the authorization is visible and persisted;
 * otherwise record `authorized`. Returns the outcome the service stamps onto the audit row.
 */
export const channelExecutor: ApprovalExecutor = {
  async execute(req: ApprovalRequest) {
    if (!req.channelId) return { outcome: "authorized" };
    const message = await postMessage({
      workspaceId: req.workspaceId,
      channelId: req.channelId,
      authorMemberId: req.requestedByMemberId,
      body: `✅ approved action executed: ${req.actionSummary}`,
    });
    publishMessageEvent(req.channelId, message).catch(() => {
      /* best-effort realtime; the message is already persisted */
    });
    return { outcome: `posted message ${message.id}` };
  },
};

/** Build a notifier that alerts every human in the workspace (except the requester) of a pending request. */
function humanApproverNotifier(log: FastifyBaseLogger): ApprovalNotifier {
  return {
    async notifyPending(req: ApprovalRequest) {
      const humans = await listWorkspaceMembersByKind(req.workspaceId, "human");
      await Promise.all(
        humans
          .filter((m) => m.id !== req.requestedByMemberId)
          .map((m) =>
            notify(log, {
              workspaceId: req.workspaceId,
              recipientMemberId: m.id,
              type: "approval",
              actorMemberId: req.requestedByMemberId,
              channelId: req.channelId,
              excerpt: req.actionSummary,
            }),
          ),
      );
    },
  };
}

/** Construct the production ApprovalService bound to a request/app logger. */
export function createDefaultApprovalService(log: FastifyBaseLogger): ApprovalService {
  return new ApprovalService({
    store: dbApprovalStore,
    executor: channelExecutor,
    notifier: humanApproverNotifier(log),
  });
}
