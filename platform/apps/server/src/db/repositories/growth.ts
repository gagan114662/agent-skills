import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { growthEvents, growthExperiments } from "../schema/index.js";
import type {
  ExperimentStatus,
  GrowthEventKind,
  GrowthEventRecord,
  GrowthExperimentRecord,
} from "../../growth/types.js";

/**
 * Growth Loop repository (#102, ADR-0102). Workspace-scoped throughout (the #3 IDOR discipline); the
 * pure funnel/score/recommend logic lives in `../../growth/score.ts` — this is persistence only.
 */

const EVENT_COLS = {
  id: growthEvents.id,
  workspaceId: growthEvents.workspaceId,
  ideaId: growthEvents.ideaId,
  kind: growthEvents.kind,
  source: growthEvents.source,
  value: growthEvents.value,
  metadata: growthEvents.metadata,
  occurredAt: growthEvents.occurredAt,
  createdAt: growthEvents.createdAt,
} as const;

export async function insertEvent(input: {
  workspaceId: string;
  ideaId: string | null;
  kind: GrowthEventKind;
  source: string;
  value: number;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}): Promise<GrowthEventRecord> {
  const [row] = await db
    .insert(growthEvents)
    .values({
      workspaceId: input.workspaceId,
      ideaId: input.ideaId,
      kind: input.kind,
      source: input.source,
      value: input.value,
      metadata: input.metadata,
      occurredAt: input.occurredAt,
    })
    .returning(EVENT_COLS);
  return row as GrowthEventRecord;
}

/** Every growth event for a workspace, optionally narrowed to one venture idea. Workspace-scoped. */
export async function listEvents(
  workspaceId: string,
  ideaId?: string,
): Promise<GrowthEventRecord[]> {
  const where =
    ideaId === undefined
      ? eq(growthEvents.workspaceId, workspaceId)
      : and(eq(growthEvents.workspaceId, workspaceId), eq(growthEvents.ideaId, ideaId));
  const rows = await db
    .select(EVENT_COLS)
    .from(growthEvents)
    .where(where)
    .orderBy(desc(growthEvents.occurredAt));
  return rows as GrowthEventRecord[];
}

const EXPERIMENT_COLS = {
  id: growthExperiments.id,
  workspaceId: growthExperiments.workspaceId,
  ideaId: growthExperiments.ideaId,
  channel: growthExperiments.channel,
  hypothesis: growthExperiments.hypothesis,
  variant: growthExperiments.variant,
  metricKey: growthExperiments.metricKey,
  targetQuery: growthExperiments.targetQuery,
  status: growthExperiments.status,
  proposedByMemberId: growthExperiments.proposedByMemberId,
  approvalRequestId: growthExperiments.approvalRequestId,
  resultSummary: growthExperiments.resultSummary,
  result: growthExperiments.result,
  decision: growthExperiments.decision,
  createdAt: growthExperiments.createdAt,
  updatedAt: growthExperiments.updatedAt,
} as const;

export async function insertExperiment(input: {
  workspaceId: string;
  ideaId: string | null;
  channel: string;
  hypothesis: string;
  variant: string;
  metricKey: string;
  targetQuery: string;
  proposedByMemberId: string | null;
}): Promise<GrowthExperimentRecord> {
  const [row] = await db
    .insert(growthExperiments)
    .values({
      workspaceId: input.workspaceId,
      ideaId: input.ideaId,
      channel: input.channel,
      hypothesis: input.hypothesis,
      variant: input.variant,
      metricKey: input.metricKey,
      targetQuery: input.targetQuery,
      proposedByMemberId: input.proposedByMemberId,
    })
    .returning(EXPERIMENT_COLS);
  return row as GrowthExperimentRecord;
}

export async function getExperiment(
  workspaceId: string,
  id: string,
): Promise<GrowthExperimentRecord | undefined> {
  const [row] = await db
    .select(EXPERIMENT_COLS)
    .from(growthExperiments)
    .where(and(eq(growthExperiments.workspaceId, workspaceId), eq(growthExperiments.id, id)))
    .limit(1);
  return row as GrowthExperimentRecord | undefined;
}

export async function listExperiments(workspaceId: string): Promise<GrowthExperimentRecord[]> {
  const rows = await db
    .select(EXPERIMENT_COLS)
    .from(growthExperiments)
    .where(eq(growthExperiments.workspaceId, workspaceId))
    .orderBy(desc(growthExperiments.createdAt))
    .limit(100);
  return rows as GrowthExperimentRecord[];
}

/**
 * Link the #13 approval request created for an experiment's external post (the post itself stays
 * gated; the experiment's lifecycle status is untouched — a human still has to approve the post). The
 * `status` arg lets a caller also advance the lifecycle (e.g. `running`) in the same write when set.
 */
export async function linkExperimentApproval(
  workspaceId: string,
  id: string,
  approvalRequestId: string,
  now: Date,
  status?: ExperimentStatus,
): Promise<GrowthExperimentRecord | undefined> {
  const [row] = await db
    .update(growthExperiments)
    .set({ approvalRequestId, ...(status ? { status } : {}), updatedAt: now })
    .where(and(eq(growthExperiments.workspaceId, workspaceId), eq(growthExperiments.id, id)))
    .returning(EXPERIMENT_COLS);
  return row as GrowthExperimentRecord | undefined;
}

export async function updateExperimentStatus(
  workspaceId: string,
  id: string,
  status: ExperimentStatus,
  resultSummary: string,
  now: Date,
): Promise<GrowthExperimentRecord | undefined> {
  const [row] = await db
    .update(growthExperiments)
    .set({ status, resultSummary, updatedAt: now })
    .where(and(eq(growthExperiments.workspaceId, workspaceId), eq(growthExperiments.id, id)))
    .returning(EXPERIMENT_COLS);
  return row as GrowthExperimentRecord | undefined;
}

export async function completeExperiment(
  workspaceId: string,
  id: string,
  result: string,
  decision: string,
  now: Date,
): Promise<GrowthExperimentRecord | undefined> {
  const [row] = await db
    .update(growthExperiments)
    .set({
      status: "completed",
      resultSummary: result,
      result,
      decision,
      updatedAt: now,
    })
    .where(and(eq(growthExperiments.workspaceId, workspaceId), eq(growthExperiments.id, id)))
    .returning(EXPERIMENT_COLS);
  return row as GrowthExperimentRecord | undefined;
}
