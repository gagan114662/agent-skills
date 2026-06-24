import {
  normalizeAuditEvents,
  type AuditEvent,
  type ApprovalAuditRow,
  type CredentialAuditRow,
  type RunAuditRow,
  type LaunchAuditRow,
} from "./normalize.js";

/**
 * Audit-trail IO service (#147, ADR-0147 §5). Reads the three already-recorded, tenant-scoped sources
 * (#13 approvals, #147 runs, #123 launches) + the member roster, builds a label resolver, and hands
 * everything to the pure {@link normalizeAuditEvents}. Read-only — no writes, no migration. Every
 * reader filters `workspace_id` (the #3 tenant boundary).
 */
export interface AuditDeps {
  listApprovals: (workspaceId: string) => Promise<ApprovalAuditRow[]>;
  listRuns: (workspaceId: string) => Promise<RunAuditRow[]>;
  listLaunches: (workspaceId: string) => Promise<LaunchAuditRow[]>;
  listCredentials?: (workspaceId: string) => Promise<CredentialAuditRow[]>;
  listMembers: (workspaceId: string) => Promise<{ id: string; displayName: string }[]>;
}

export class AuditService {
  constructor(private readonly deps: AuditDeps) {}

  /** The workspace's audit feed (newest first), capped at `limit`. */
  async get(workspaceId: string, limit = 200): Promise<AuditEvent[]> {
    const [approvals, runs, launches, credentials, members] = await Promise.all([
      this.deps.listApprovals(workspaceId),
      this.deps.listRuns(workspaceId),
      this.deps.listLaunches(workspaceId),
      this.deps.listCredentials?.(workspaceId) ?? Promise.resolve([]),
      this.deps.listMembers(workspaceId),
    ]);
    const labels = new Map(members.map((m) => [m.id, m.displayName]));
    return normalizeAuditEvents({
      approvals,
      runs,
      launches,
      credentials,
      labelFor: (memberId) => (memberId && labels.get(memberId)) || "system",
      limit,
    });
  }
}
