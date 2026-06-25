import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { deployTargets, deployReleases } from "../schema/index.js";
import type { DeployTarget, ReleaseReceipt } from "../../venture-deploy/types.js";
import type {
  CreateDeployTargetInput,
  CreateReleaseReceiptInput,
  DeployTargetStore,
  ReleaseStore,
} from "../../venture-deploy/store.js";

const TARGET_COLUMNS = {
  id: deployTargets.id,
  workspaceId: deployTargets.workspaceId,
  ventureId: deployTargets.ventureId,
  provider: deployTargets.provider,
  projectId: deployTargets.projectId,
  previewUrl: deployTargets.previewUrl,
  prodUrl: deployTargets.prodUrl,
  status: deployTargets.status,
  secretServiceKey: deployTargets.secretServiceKey,
  createdAt: deployTargets.createdAt,
} as const;

const RELEASE_COLUMNS = {
  id: deployReleases.id,
  workspaceId: deployReleases.workspaceId,
  ventureId: deployReleases.ventureId,
  targetId: deployReleases.targetId,
  releaseRef: deployReleases.releaseRef,
  status: deployReleases.status,
  action: deployReleases.action,
  reversibility: deployReleases.reversibility,
  requiresApproval: deployReleases.requiresApproval,
  approvalRequestId: deployReleases.approvalRequestId,
  smokeCriticalCount: deployReleases.smokeCriticalCount,
  promoteHealthOk: deployReleases.promoteHealthOk,
  promoteHealthDetail: deployReleases.promoteHealthDetail,
  url: deployReleases.url,
  incidentFiled: deployReleases.incidentFiled,
  detail: deployReleases.detail,
  createdAt: deployReleases.createdAt,
} as const;

/**
 * Repository-backed deploy-target store (#195) implementing the injectable {@link DeployTargetStore}
 * seam. Reads are **workspace-scoped** (the #3 tenant boundary); the `(workspace, venture)` unique key
 * makes `create` idempotent under a race (a duplicate insert raises, the orchestrator re-reads).
 */
export const dbDeployTargetStore: DeployTargetStore = {
  async getByVenture(workspaceId: string, ventureId: string): Promise<DeployTarget | undefined> {
    const [row] = await db
      .select(TARGET_COLUMNS)
      .from(deployTargets)
      .where(
        and(eq(deployTargets.workspaceId, workspaceId), eq(deployTargets.ventureId, ventureId)),
      )
      .limit(1);
    return row as DeployTarget | undefined;
  },

  async create(input: CreateDeployTargetInput): Promise<DeployTarget> {
    const [row] = await db.insert(deployTargets).values(input).returning(TARGET_COLUMNS);
    return row as DeployTarget;
  },
};

/** Repository-backed immutable release-receipt store (#195) — the audit trail (AC4). */
export const dbReleaseStore: ReleaseStore = {
  async getByRelease(
    workspaceId: string,
    ventureId: string,
    releaseRef: string,
  ): Promise<ReleaseReceipt | null> {
    const [row] = await db
      .select(RELEASE_COLUMNS)
      .from(deployReleases)
      .where(
        and(
          eq(deployReleases.workspaceId, workspaceId),
          eq(deployReleases.ventureId, ventureId),
          eq(deployReleases.releaseRef, releaseRef),
        ),
      )
      .limit(1);
    return (row as ReleaseReceipt | undefined) ?? null;
  },

  async create(input: CreateReleaseReceiptInput): Promise<ReleaseReceipt> {
    const [row] = await db
      .insert(deployReleases)
      .values({
        workspaceId: input.workspaceId,
        ventureId: input.ventureId,
        targetId: input.targetId,
        releaseRef: input.releaseRef,
        status: input.status,
        action: input.action,
        reversibility: input.reversibility,
        requiresApproval: input.requiresApproval,
        approvalRequestId: input.approvalRequestId ?? null,
        smokeCriticalCount: input.smokeCriticalCount,
        promoteHealthOk: input.promoteHealthOk ?? null,
        promoteHealthDetail: input.promoteHealthDetail ?? null,
        url: input.url ?? null,
        incidentFiled: input.incidentFiled,
        detail: input.detail,
      })
      .returning(RELEASE_COLUMNS);
    return row as ReleaseReceipt;
  },

  async update(id: string, input: Partial<CreateReleaseReceiptInput>): Promise<ReleaseReceipt> {
    const patch: Partial<typeof deployReleases.$inferInsert> = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.action !== undefined) patch.action = input.action;
    if (input.reversibility !== undefined) patch.reversibility = input.reversibility;
    if (input.requiresApproval !== undefined) patch.requiresApproval = input.requiresApproval;
    if (input.approvalRequestId !== undefined) patch.approvalRequestId = input.approvalRequestId;
    if (input.smokeCriticalCount !== undefined) patch.smokeCriticalCount = input.smokeCriticalCount;
    if (input.promoteHealthOk !== undefined) patch.promoteHealthOk = input.promoteHealthOk;
    if (input.promoteHealthDetail !== undefined)
      patch.promoteHealthDetail = input.promoteHealthDetail;
    if (input.url !== undefined) patch.url = input.url;
    if (input.incidentFiled !== undefined) patch.incidentFiled = input.incidentFiled;
    if (input.detail !== undefined) patch.detail = input.detail;
    const [row] = await db
      .update(deployReleases)
      .set(patch)
      .where(eq(deployReleases.id, id))
      .returning(RELEASE_COLUMNS);
    return row as ReleaseReceipt;
  },

  async listRecentForWorkspace(workspaceId: string, limit = 20): Promise<ReleaseReceipt[]> {
    const rows = await db
      .select(RELEASE_COLUMNS)
      .from(deployReleases)
      .where(eq(deployReleases.workspaceId, workspaceId))
      .orderBy(desc(deployReleases.createdAt))
      .limit(limit);
    return rows as ReleaseReceipt[];
  },
};
