import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../index.js";
import { backlogItems, planningSpecs } from "../schema/index.js";
import type {
  BacklogItemRecord,
  BacklogSource,
  BacklogStatus,
  PlanningSpecRecord,
} from "../../planning/types.js";

/**
 * Product Planning Loop repository (#115, ADR-0115). Workspace-scoped throughout (the #3 IDOR
 * discipline); the pure RICE/rank/decide/spec logic lives in `../../planning/*` — this is persistence
 * only.
 */

const ITEM_COLS = {
  id: backlogItems.id,
  workspaceId: backlogItems.workspaceId,
  ideaId: backlogItems.ideaId,
  title: backlogItems.title,
  description: backlogItems.description,
  source: backlogItems.source,
  sourceRef: backlogItems.sourceRef,
  reach: backlogItems.reach,
  impact: backlogItems.impact,
  confidencePct: backlogItems.confidencePct,
  effort: backlogItems.effort,
  isPivot: backlogItems.isPivot,
  status: backlogItems.status,
  targetChannelId: backlogItems.targetChannelId,
  targetAgentMemberId: backlogItems.targetAgentMemberId,
  specId: backlogItems.specId,
  approvalRequestId: backlogItems.approvalRequestId,
  createdAt: backlogItems.createdAt,
  updatedAt: backlogItems.updatedAt,
} as const;

export async function insertBacklogItem(input: {
  workspaceId: string;
  ideaId: string | null;
  title: string;
  description: string;
  source: BacklogSource;
  sourceRef: string;
  reach: number;
  impact: number;
  confidencePct: number;
  effort: number;
  isPivot: boolean;
  targetChannelId: string | null;
  targetAgentMemberId: string | null;
}): Promise<BacklogItemRecord> {
  const [row] = await db
    .insert(backlogItems)
    .values({
      workspaceId: input.workspaceId,
      ideaId: input.ideaId,
      title: input.title,
      description: input.description,
      source: input.source,
      sourceRef: input.sourceRef,
      reach: input.reach,
      impact: input.impact,
      confidencePct: input.confidencePct,
      effort: input.effort,
      isPivot: input.isPivot,
      targetChannelId: input.targetChannelId,
      targetAgentMemberId: input.targetAgentMemberId,
    })
    .returning(ITEM_COLS);
  return row as BacklogItemRecord;
}

export async function getBacklogItem(
  workspaceId: string,
  id: string,
): Promise<BacklogItemRecord | undefined> {
  const [row] = await db
    .select(ITEM_COLS)
    .from(backlogItems)
    .where(and(eq(backlogItems.workspaceId, workspaceId), eq(backlogItems.id, id)))
    .limit(1);
  return row as BacklogItemRecord | undefined;
}

/** Every backlog item for a workspace, optionally narrowed to a set of statuses. Workspace-scoped. */
export async function listBacklogItems(
  workspaceId: string,
  statuses?: readonly BacklogStatus[],
): Promise<BacklogItemRecord[]> {
  const where =
    statuses && statuses.length > 0
      ? and(eq(backlogItems.workspaceId, workspaceId), inArray(backlogItems.status, [...statuses]))
      : eq(backlogItems.workspaceId, workspaceId);
  const rows = await db
    .select(ITEM_COLS)
    .from(backlogItems)
    .where(where)
    .orderBy(desc(backlogItems.createdAt))
    .limit(500);
  return rows as BacklogItemRecord[];
}

/** Patch the lifecycle/linkage fields of a backlog item (workspace-scoped). Bumps `updated_at`. */
export async function updateBacklogItem(
  workspaceId: string,
  id: string,
  patch: {
    status?: BacklogStatus;
    specId?: string;
    approvalRequestId?: string;
  },
  now: Date,
): Promise<BacklogItemRecord | undefined> {
  const [row] = await db
    .update(backlogItems)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.specId ? { specId: patch.specId } : {}),
      ...(patch.approvalRequestId ? { approvalRequestId: patch.approvalRequestId } : {}),
      updatedAt: now,
    })
    .where(and(eq(backlogItems.workspaceId, workspaceId), eq(backlogItems.id, id)))
    .returning(ITEM_COLS);
  return row as BacklogItemRecord | undefined;
}

const SPEC_COLS = {
  id: planningSpecs.id,
  workspaceId: planningSpecs.workspaceId,
  backlogItemId: planningSpecs.backlogItemId,
  title: planningSpecs.title,
  body: planningSpecs.body,
  status: planningSpecs.status,
  sessionId: planningSpecs.sessionId,
  approvalRequestId: planningSpecs.approvalRequestId,
  createdAt: planningSpecs.createdAt,
  updatedAt: planningSpecs.updatedAt,
} as const;

export async function insertPlanningSpec(input: {
  workspaceId: string;
  backlogItemId: string;
  title: string;
  body: string;
}): Promise<PlanningSpecRecord> {
  const [row] = await db
    .insert(planningSpecs)
    .values({
      workspaceId: input.workspaceId,
      backlogItemId: input.backlogItemId,
      title: input.title,
      body: input.body,
    })
    .returning(SPEC_COLS);
  return row as PlanningSpecRecord;
}

/** The most recent spec drafted for a backlog item (workspace-scoped), or undefined. */
export async function getSpecForItem(
  workspaceId: string,
  backlogItemId: string,
): Promise<PlanningSpecRecord | undefined> {
  const [row] = await db
    .select(SPEC_COLS)
    .from(planningSpecs)
    .where(
      and(eq(planningSpecs.workspaceId, workspaceId), eq(planningSpecs.backlogItemId, backlogItemId)),
    )
    .orderBy(desc(planningSpecs.createdAt))
    .limit(1);
  return row as PlanningSpecRecord | undefined;
}

export async function listPlanningSpecs(workspaceId: string): Promise<PlanningSpecRecord[]> {
  const rows = await db
    .select(SPEC_COLS)
    .from(planningSpecs)
    .where(eq(planningSpecs.workspaceId, workspaceId))
    .orderBy(desc(planningSpecs.createdAt))
    .limit(200);
  return rows as PlanningSpecRecord[];
}

/** Link the proposed build session + advance the spec to `dispatched` (workspace-scoped). */
export async function linkSpecSession(
  workspaceId: string,
  id: string,
  sessionId: string,
  now: Date,
): Promise<PlanningSpecRecord | undefined> {
  const [row] = await db
    .update(planningSpecs)
    .set({ sessionId, status: "dispatched", updatedAt: now })
    .where(and(eq(planningSpecs.workspaceId, workspaceId), eq(planningSpecs.id, id)))
    .returning(SPEC_COLS);
  return row as PlanningSpecRecord | undefined;
}

/** Link the #13 approval request gating a queued spec dispatch (the spec stays `draft`). */
export async function linkSpecApproval(
  workspaceId: string,
  id: string,
  approvalRequestId: string,
  now: Date,
): Promise<PlanningSpecRecord | undefined> {
  const [row] = await db
    .update(planningSpecs)
    .set({ approvalRequestId, updatedAt: now })
    .where(and(eq(planningSpecs.workspaceId, workspaceId), eq(planningSpecs.id, id)))
    .returning(SPEC_COLS);
  return row as PlanningSpecRecord | undefined;
}

/** Workspaces with at least one non-terminal backlog item — the planning tick work-list. */
export async function listActivePlanningWorkspaces(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: backlogItems.workspaceId })
    .from(backlogItems)
    .where(inArray(backlogItems.status, ["proposed", "specced"]));
  return rows.map((r) => r.workspaceId as string);
}
