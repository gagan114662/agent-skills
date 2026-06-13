import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { externalSetupRequests } from "../schema/index.js";
import type { Reversibility, ServiceKind, SetupRequestStatus } from "../../onboarding/types.js";

/**
 * External setup-request repository (#192, ADR-0192). Workspace-scoped throughout (#3 IDOR discipline).
 * The fleet files a request per missing service; `unique(workspace_id, service_key)` makes re-filing an
 * upsert (no duplicate stacking). `approvalRequestId` softly links the #13 pending approval that parks
 * the request in the decision queue — the onboarding layer never owns the approvals table.
 */

export interface SetupRequestRow {
  id: string;
  serviceKey: string;
  serviceKind: ServiceKind;
  displayName: string;
  plan: string | null;
  scopes: string[];
  reason: string;
  projectedCostCents: number;
  reversibility: Reversibility;
  status: SetupRequestStatus;
  approvalRequestId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Insert or upsert a setup request (re-filing the same service updates it in place). Returns the row. */
export async function upsertSetupRequest(input: {
  workspaceId: string;
  serviceKey: string;
  serviceKind: ServiceKind;
  displayName: string;
  plan: string | null;
  scopes: string[];
  reason: string;
  projectedCostCents: number;
  reversibility: Reversibility;
  approvalRequestId?: string | null;
  requestedByMemberId?: string | null;
}): Promise<SetupRequestRow> {
  const now = new Date();
  const [row] = await db
    .insert(externalSetupRequests)
    .values({
      workspaceId: input.workspaceId,
      serviceKey: input.serviceKey,
      serviceKind: input.serviceKind,
      displayName: input.displayName,
      plan: input.plan,
      scopes: input.scopes,
      reason: input.reason,
      projectedCostCents: input.projectedCostCents,
      reversibility: input.reversibility,
      status: "requested",
      approvalRequestId: input.approvalRequestId ?? null,
      requestedByMemberId: input.requestedByMemberId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [externalSetupRequests.workspaceId, externalSetupRequests.serviceKey],
      set: {
        serviceKind: input.serviceKind,
        displayName: input.displayName,
        plan: input.plan,
        scopes: input.scopes,
        reason: input.reason,
        projectedCostCents: input.projectedCostCents,
        reversibility: input.reversibility,
        // Re-filing a still-open request keeps it `requested`; an already-connected service stays connected.
        approvalRequestId: input.approvalRequestId ?? null,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("upsertSetupRequest: insert returned no row");
  return mapRow(row);
}

/** List a workspace's setup requests, newest first (read-only, tenant-scoped). */
export async function listSetupRequests(workspaceId: string): Promise<SetupRequestRow[]> {
  const rows = await db
    .select()
    .from(externalSetupRequests)
    .where(eq(externalSetupRequests.workspaceId, workspaceId))
    .orderBy(desc(externalSetupRequests.createdAt));
  return rows.map(mapRow);
}

/** Set a request's status (`connected` when keys land, `dismissed` when the owner declines). */
export async function setSetupRequestStatus(
  workspaceId: string,
  serviceKey: string,
  status: SetupRequestStatus,
): Promise<void> {
  await db
    .update(externalSetupRequests)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(externalSetupRequests.workspaceId, workspaceId),
        eq(externalSetupRequests.serviceKey, serviceKey),
      ),
    );
}

function mapRow(row: typeof externalSetupRequests.$inferSelect): SetupRequestRow {
  return {
    id: row.id,
    serviceKey: row.serviceKey,
    serviceKind: row.serviceKind as ServiceKind,
    displayName: row.displayName,
    plan: row.plan,
    scopes: (row.scopes as string[]) ?? [],
    reason: row.reason,
    projectedCostCents: row.projectedCostCents,
    reversibility: row.reversibility as Reversibility,
    status: row.status as SetupRequestStatus,
    approvalRequestId: row.approvalRequestId,
    createdAtMs: row.createdAt.getTime(),
    updatedAtMs: row.updatedAt.getTime(),
  };
}
