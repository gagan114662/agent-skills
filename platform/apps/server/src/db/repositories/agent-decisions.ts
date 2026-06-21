import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "../index.js";
import { agentDecisions } from "../schema/index.js";

/**
 * Decision-store repository (issue #513). Workspace-scoped (#3 IDOR discipline) with idempotent writes:
 * a re-recorded decision (same `workspace_id` + `dedupe_key`) collapses to the existing row. All
 * typing/dedup/sanitization/approval-gating lives in `decisions/*` + the service — this layer is pure
 * persistence over `agent_decisions`.
 */

export interface AgentDecisionRow {
  id: string;
  workspaceId: string;
  topic: string;
  title: string;
  rationale: string;
  decidedByMemberId: string | null;
  status: "recorded" | "superseded";
  memoryId: string | null;
  taskId: string | null;
  approvalRequestId: string | null;
  /** set ⇒ replaced by a newer decision (kept, not deleted — version history). */
  supersededByDecisionId: string | null;
  createdAt: Date;
  supersededAt: Date | null;
}

const COLS = {
  id: agentDecisions.id,
  workspaceId: agentDecisions.workspaceId,
  topic: agentDecisions.topic,
  title: agentDecisions.title,
  rationale: agentDecisions.rationale,
  decidedByMemberId: agentDecisions.decidedByMemberId,
  status: agentDecisions.status,
  memoryId: agentDecisions.memoryId,
  taskId: agentDecisions.taskId,
  approvalRequestId: agentDecisions.approvalRequestId,
  supersededByDecisionId: agentDecisions.supersededByDecisionId,
  createdAt: agentDecisions.createdAt,
  supersededAt: agentDecisions.supersededAt,
};

export interface RecordDecisionInput {
  workspaceId: string;
  topic: string;
  title: string;
  rationale: string;
  dedupeKey: string;
  decidedByMemberId?: string | null;
  memoryId?: string | null;
  taskId?: string | null;
  approvalRequestId?: string | null;
}

/** Insert a decision, or merge into the existing one sharing its (workspace, dedupe_key). Idempotent. */
export async function recordDecision(
  input: RecordDecisionInput,
): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(agentDecisions)
    .values({
      workspaceId: input.workspaceId,
      topic: input.topic,
      title: input.title,
      rationale: input.rationale,
      dedupeKey: input.dedupeKey,
      decidedByMemberId: input.decidedByMemberId ?? null,
      memoryId: input.memoryId ?? null,
      taskId: input.taskId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
    })
    .onConflictDoNothing({ target: [agentDecisions.workspaceId, agentDecisions.dedupeKey] })
    .returning({ id: agentDecisions.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };

  const [existing] = await db
    .select({ id: agentDecisions.id })
    .from(agentDecisions)
    .where(
      and(
        eq(agentDecisions.workspaceId, input.workspaceId),
        eq(agentDecisions.dedupeKey, input.dedupeKey),
      ),
    )
    .limit(1);
  return { id: existing!.id, created: false };
}

/** A decision by id, scoped to the workspace (undefined if absent or cross-workspace). */
export async function getDecision(
  workspaceId: string,
  id: string,
): Promise<AgentDecisionRow | undefined> {
  const [row] = await db
    .select(COLS)
    .from(agentDecisions)
    .where(and(eq(agentDecisions.workspaceId, workspaceId), eq(agentDecisions.id, id)))
    .limit(1);
  return row as AgentDecisionRow | undefined;
}

/**
 * Browse decisions, newest first. Optional `topic` filter; superseded (stale) decisions are excluded by
 * default — pass `includeSuperseded` to surface version history. `limit` caps the page (default 50).
 */
export async function listDecisions(
  workspaceId: string,
  filter: { topic?: string; includeSuperseded?: boolean; limit?: number } = {},
): Promise<AgentDecisionRow[]> {
  const conds: SQL[] = [eq(agentDecisions.workspaceId, workspaceId)];
  if (filter.topic) conds.push(eq(agentDecisions.topic, filter.topic));
  if (!filter.includeSuperseded) conds.push(isNull(agentDecisions.supersededByDecisionId));
  return db
    .select(COLS)
    .from(agentDecisions)
    .where(and(...conds))
    .orderBy(desc(agentDecisions.createdAt))
    .limit(Math.max(1, Math.min(200, filter.limit ?? 50))) as Promise<AgentDecisionRow[]>;
}

/**
 * Recall the live decisions an agent should reuse before deciding — newest first, capped. With `topic`,
 * the precise prior decisions on that subject; without it, the workspace's most recent decisions as
 * general "prior decisions on file". Never returns superseded rows (an agent reuses the current call).
 */
export async function recallDecisions(
  workspaceId: string,
  query: { topic?: string; limit?: number } = {},
): Promise<AgentDecisionRow[]> {
  return listDecisions(workspaceId, {
    topic: query.topic,
    includeSuperseded: false,
    limit: query.limit ?? 5,
  });
}

/** Count the live (non-superseded) decisions in a workspace — the real backing for the "decisions" counter. */
export async function countLiveDecisions(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: agentDecisions.id })
    .from(agentDecisions)
    .where(
      and(
        eq(agentDecisions.workspaceId, workspaceId),
        isNull(agentDecisions.supersededByDecisionId),
      ),
    );
  return rows.length;
}

/**
 * Supersede `oldId` with a newer decision (mirrors the #16 memory supersede). Inserts the replacement
 * (dedup-aware), marks the old row stale (`superseded_by_decision_id` + `superseded_at` — kept, not
 * deleted). Atomic. If the replacement dedups into the old row itself, it is a no-op (`superseded:false`).
 * Callers must validate `oldId` is in-workspace first.
 */
export async function supersedeDecision(input: {
  workspaceId: string;
  oldId: string;
  topic: string;
  title: string;
  rationale: string;
  dedupeKey: string;
  decidedByMemberId?: string | null;
  memoryId?: string | null;
  taskId?: string | null;
  approvalRequestId?: string | null;
}): Promise<{ newId: string; created: boolean; superseded: boolean }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(agentDecisions)
      .values({
        workspaceId: input.workspaceId,
        topic: input.topic,
        title: input.title,
        rationale: input.rationale,
        dedupeKey: input.dedupeKey,
        decidedByMemberId: input.decidedByMemberId ?? null,
        memoryId: input.memoryId ?? null,
        taskId: input.taskId ?? null,
        approvalRequestId: input.approvalRequestId ?? null,
      })
      .onConflictDoNothing({ target: [agentDecisions.workspaceId, agentDecisions.dedupeKey] })
      .returning({ id: agentDecisions.id });

    let newId: string;
    let created: boolean;
    if (inserted[0]) {
      newId = inserted[0].id;
      created = true;
    } else {
      const [existing] = await tx
        .select({ id: agentDecisions.id })
        .from(agentDecisions)
        .where(
          and(
            eq(agentDecisions.workspaceId, input.workspaceId),
            eq(agentDecisions.dedupeKey, input.dedupeKey),
          ),
        )
        .limit(1);
      newId = existing!.id;
      created = false;
    }

    // a decision never supersedes itself (the replacement dedup'd into the old row)
    if (newId === input.oldId) return { newId, created, superseded: false };

    await tx
      .update(agentDecisions)
      .set({ status: "superseded", supersededByDecisionId: newId, supersededAt: new Date() })
      .where(
        and(
          eq(agentDecisions.workspaceId, input.workspaceId),
          eq(agentDecisions.id, input.oldId),
        ),
      );

    return { newId, created, superseded: true };
  });
}
