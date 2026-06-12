import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../index.js";
import { workflows, workflowRuns } from "../schema/index.js";
import type { WorkflowStore } from "../../workflows/engine.js";
import type { WorkflowRecord, WorkflowRun } from "../../workflows/types.js";

/**
 * Durable store for the Workflow builder (#152, ADR-0152). Implements the {@link WorkflowStore} engine
 * seam over `workflows` / `workflow_runs`. Every read filters `workspace_id` (the #3 tenant boundary);
 * `findByWebhookHash` is the one cross-workspace lookup (a webhook token resolves to its own workspace)
 * and `activeWorkspaces` is the schedule tick work-list.
 */

const W_COLUMNS = {
  id: workflows.id,
  workspaceId: workflows.workspaceId,
  name: workflows.name,
  triggerKind: workflows.triggerKind,
  trigger: workflows.trigger,
  conditions: workflows.conditions,
  actions: workflows.actions,
  enabled: workflows.enabled,
  createdByMemberId: workflows.createdByMemberId,
  lastFiredAt: workflows.lastFiredAt,
  nextRunAt: workflows.nextRunAt,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
} as const;

function toRecord(row: Record<string, unknown>): WorkflowRecord {
  return {
    ...(row as Omit<WorkflowRecord, "trigger" | "conditions" | "actions">),
    trigger: (row.trigger as WorkflowRecord["trigger"]) ?? { kind: "schedule" },
    conditions: (row.conditions as WorkflowRecord["conditions"]) ?? [],
    actions: (row.actions as WorkflowRecord["actions"]) ?? [],
  } as WorkflowRecord;
}

export const workflowStore: WorkflowStore = {
  async create(input) {
    const [row] = await db
      .insert(workflows)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        triggerKind: input.triggerKind,
        trigger: input.trigger,
        conditions: input.conditions,
        actions: input.actions,
        webhookTokenHash: input.webhookTokenHash,
        enabled: input.enabled,
        createdByMemberId: input.createdByMemberId,
        nextRunAt: input.nextRunAt,
      })
      .returning(W_COLUMNS);
    return toRecord(row!);
  },

  async get(workspaceId, id) {
    const [row] = await db
      .select(W_COLUMNS)
      .from(workflows)
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, id)))
      .limit(1);
    return row ? toRecord(row) : null;
  },

  async list(workspaceId) {
    const rows = await db
      .select(W_COLUMNS)
      .from(workflows)
      .where(eq(workflows.workspaceId, workspaceId))
      .orderBy(desc(workflows.createdAt));
    return rows.map(toRecord);
  },

  async countForWorkspace(workspaceId) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflows)
      .where(eq(workflows.workspaceId, workspaceId));
    return row?.n ?? 0;
  },

  async setEnabled(workspaceId, id, enabled, nextRunAt) {
    const [row] = await db
      .update(workflows)
      .set({ enabled, nextRunAt, updatedAt: new Date() })
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, id)))
      .returning(W_COLUMNS);
    return row ? toRecord(row) : null;
  },

  async remove(workspaceId, id) {
    const deleted = await db
      .delete(workflows)
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, id)))
      .returning({ id: workflows.id });
    return deleted.length > 0;
  },

  async listDue(workspaceId, now) {
    const rows = await db
      .select(W_COLUMNS)
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          eq(workflows.enabled, true),
          eq(workflows.triggerKind, "schedule"),
          isNotNull(workflows.nextRunAt),
          lte(workflows.nextRunAt, now),
        ),
      )
      .orderBy(workflows.nextRunAt);
    return rows.map(toRecord);
  },

  async listByTrigger(workspaceId, triggerKind) {
    const rows = await db
      .select(W_COLUMNS)
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          eq(workflows.enabled, true),
          eq(workflows.triggerKind, triggerKind),
        ),
      )
      .orderBy(desc(workflows.createdAt));
    return rows.map(toRecord);
  },

  async markFired({ id, lastFiredAt, nextRunAt }) {
    await db
      .update(workflows)
      .set({ lastFiredAt, nextRunAt, updatedAt: new Date() })
      .where(eq(workflows.id, id));
  },

  async recordRun(input) {
    const [row] = await db
      .insert(workflowRuns)
      .values({
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        trigger: input.trigger,
        status: input.status,
        reason: input.reason,
        results: input.results,
      })
      .returning();
    return toRun(row as Record<string, unknown>);
  },

  async listRuns(workspaceId, limit = 100) {
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workspaceId, workspaceId))
      .orderBy(desc(workflowRuns.createdAt))
      .limit(limit);
    return rows.map((r) => toRun(r as Record<string, unknown>));
  },

  async countRunsInWindow(workspaceId, since) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workspaceId, workspaceId),
          eq(workflowRuns.status, "fired"),
          gte(workflowRuns.createdAt, since),
        ),
      );
    return row?.n ?? 0;
  },

  async findByWebhookHash(hash) {
    const [row] = await db
      .select(W_COLUMNS)
      .from(workflows)
      .where(and(eq(workflows.webhookTokenHash, hash), eq(workflows.enabled, true)))
      .limit(1);
    return row ? toRecord(row) : null;
  },

  async activeWorkspaces() {
    const rows = await db
      .selectDistinct({ workspaceId: workflows.workspaceId })
      .from(workflows)
      .where(and(eq(workflows.enabled, true), eq(workflows.triggerKind, "schedule")));
    return rows.map((r) => r.workspaceId);
  },
};

function toRun(row: Record<string, unknown>): WorkflowRun {
  return {
    ...(row as Omit<WorkflowRun, "results">),
    results: (row.results as WorkflowRun["results"]) ?? [],
  } as WorkflowRun;
}

/** A workspace's run ledger, newest first (the console + insights source). */
export async function listWorkflowRuns(workspaceId: string, limit = 100): Promise<WorkflowRun[]> {
  return workflowStore.listRuns(workspaceId, limit);
}
