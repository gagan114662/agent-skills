import { countRequestsByStatus } from "../db/repositories/approvals.js";
import { dbWorkspacePlanStore } from "../db/repositories/plans.js";
import type { ApprovalQueueQuotaReaders } from "./approval-queue-quota.js";

export const defaultApprovalQueueQuotaReaders: ApprovalQueueQuotaReaders = {
  activePlans: dbWorkspacePlanStore,
  countPendingApprovals(workspaceId) {
    return countRequestsByStatus(workspaceId, "pending");
  },
};
