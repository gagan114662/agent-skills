import { listRequests } from "../db/repositories/approvals.js";
import { listAutomationRuns } from "../db/repositories/automations.js";
import { listMarketingTasks } from "../db/repositories/marketing-tasks.js";
import { listWorkspaceMembers } from "../db/repositories/members.js";
import { AuditService } from "./service.js";

/**
 * Production wiring for the audit trail (#147, ADR-0147). Read-only over three existing append-only,
 * tenant-scoped sources (#13 approvals, #147 automation runs, #123 marketing-task launches) + the
 * member roster — no migration, no config flag (gated only by the #19 tenant boundary in the route).
 */
export function createDefaultAuditService(): AuditService {
  return new AuditService({
    listApprovals: async (workspaceId) =>
      (await listRequests(workspaceId)).map((r) => ({
        id: r.id,
        requesterMemberId: r.requesterMemberId,
        actionType: r.actionType,
        summary: r.summary,
        status: r.status,
        createdAt: r.createdAt,
      })),
    listRuns: async (workspaceId) =>
      (await listAutomationRuns(workspaceId)).map((r) => ({
        id: r.id,
        automationId: r.automationId,
        trigger: r.trigger,
        status: r.status,
        reason: r.reason,
        task: r.task,
        createdAt: r.createdAt,
      })),
    listLaunches: async (workspaceId) =>
      (await listMarketingTasks(workspaceId)).map((t) => ({
        id: t.id,
        department: t.department,
        agentMemberId: t.agentMemberId,
        kind: t.kind,
        task: t.task,
        status: t.status,
        createdByMemberId: t.createdByMemberId,
        createdAt: t.createdAt,
      })),
    listMembers: (workspaceId) => listWorkspaceMembers(workspaceId),
  });
}
