import type { DeployTarget, ReleaseReceipt } from "./types.js";

/**
 * Persistence seams for Venture Deploys (#195), injected into the orchestrators so production persists
 * durably (`db/repositories/venture-deploy.ts`) while unit tests inject in-memory fakes — the same split
 * as the #73 `DeploymentStore`. All reads are workspace-scoped (the #3 tenant boundary).
 */

export interface CreateDeployTargetInput {
  workspaceId: string;
  ventureId: string;
  provider: DeployTarget["provider"];
  projectId: string;
  previewUrl: string;
  prodUrl: string;
  status: DeployTarget["status"];
  secretServiceKey: string;
}

export interface DeployTargetStore {
  /** The provisioned target for a venture, or undefined — the idempotency read. */
  getByVenture(workspaceId: string, ventureId: string): Promise<DeployTarget | undefined>;
  /** Insert the target. The unique `(workspace, venture)` key makes a concurrent double-create a no-op. */
  create(input: CreateDeployTargetInput): Promise<DeployTarget>;
}

export interface CreateReleaseReceiptInput {
  workspaceId: string;
  ventureId: string;
  targetId: string;
  releaseRef: string;
  status: ReleaseReceipt["status"];
  action: ReleaseReceipt["action"];
  reversibility: ReleaseReceipt["reversibility"];
  requiresApproval: boolean;
  approvalRequestId?: string | null;
  smokeCriticalCount: number;
  promoteHealthOk?: boolean | null;
  promoteHealthDetail?: string | null;
  url?: string | null;
  incidentFiled: boolean;
  detail: string;
}

export interface ReleaseStore {
  /** Append an immutable release receipt (the audit trail, #195 AC4). */
  create(input: CreateReleaseReceiptInput): Promise<ReleaseReceipt>;
  /** Recent releases across the workspace, newest first — for the daily brief (#173). */
  listRecentForWorkspace(workspaceId: string, limit?: number): Promise<ReleaseReceipt[]>;
}
