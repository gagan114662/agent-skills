import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../index.js";
import { automations, automationRuns } from "../schema/index.js";
import type { AutomationStore } from "../../automations/engine.js";
import type { AutomationRecord, AutomationRun } from "../../automations/types.js";

/**
 * Durable store for Automations (#147, ADR-0147). Implements the {@link AutomationStore} engine seam
 * over `automations` / `automation_runs`. Every read filters `workspace_id` (the #3 tenant boundary);
 * `findByWebhookHash` is the one cross-workspace lookup (a webhook token resolves to its own workspace)
 * and `activeWorkspaces` is the tick work-list. Session ids in the run ledger are soft references.
 */

const A_COLUMNS = {
  id: automations.id,
  workspaceId: automations.workspaceId,
  name: automations.name,
  triggerKind: automations.triggerKind,
  schedule: automations.schedule,
  templateKey: automations.templateKey,
  params: automations.params,
  channelId: automations.channelId,
  agentHandle: automations.agentHandle,
  enabled: automations.enabled,
  createdByMemberId: automations.createdByMemberId,
  lastRunAt: automations.lastRunAt,
  nextRunAt: automations.nextRunAt,
  createdAt: automations.createdAt,
  updatedAt: automations.updatedAt,
} as const;

function toRecord(row: Record<string, unknown>): AutomationRecord {
  return {
    ...(row as Omit<AutomationRecord, "schedule" | "params">),
    schedule: (row.schedule as AutomationRecord["schedule"]) ?? null,
    params: (row.params as Record<string, string>) ?? {},
  } as AutomationRecord;
}

export const automationStore: AutomationStore = {
  async create(input) {
    const [row] = await db
      .insert(automations)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        triggerKind: input.triggerKind,
        schedule: input.schedule,
        webhookTokenHash: input.webhookTokenHash,
        templateKey: input.templateKey,
        params: input.params,
        channelId: input.channelId,
        agentHandle: input.agentHandle,
        enabled: input.enabled,
        createdByMemberId: input.createdByMemberId,
        nextRunAt: input.nextRunAt,
      })
      .returning(A_COLUMNS);
    return toRecord(row!);
  },

  async get(workspaceId, id) {
    const [row] = await db
      .select(A_COLUMNS)
      .from(automations)
      .where(and(eq(automations.workspaceId, workspaceId), eq(automations.id, id)))
      .limit(1);
    return row ? toRecord(row) : null;
  },

  async list(workspaceId) {
    const rows = await db
      .select(A_COLUMNS)
      .from(automations)
      .where(eq(automations.workspaceId, workspaceId))
      .orderBy(desc(automations.createdAt));
    return rows.map(toRecord);
  },

  async countForWorkspace(workspaceId) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(automations)
      .where(eq(automations.workspaceId, workspaceId));
    return row?.n ?? 0;
  },

  async setEnabled(workspaceId, id, enabled, nextRunAt) {
    const [row] = await db
      .update(automations)
      .set({ enabled, nextRunAt, updatedAt: new Date() })
      .where(and(eq(automations.workspaceId, workspaceId), eq(automations.id, id)))
      .returning(A_COLUMNS);
    return row ? toRecord(row) : null;
  },

  async remove(workspaceId, id) {
    const deleted = await db
      .delete(automations)
      .where(and(eq(automations.workspaceId, workspaceId), eq(automations.id, id)))
      .returning({ id: automations.id });
    return deleted.length > 0;
  },

  async listDue(workspaceId, now) {
    const rows = await db
      .select(A_COLUMNS)
      .from(automations)
      .where(
        and(
          eq(automations.workspaceId, workspaceId),
          eq(automations.enabled, true),
          eq(automations.triggerKind, "schedule"),
          isNotNull(automations.nextRunAt),
          lte(automations.nextRunAt, now),
        ),
      )
      .orderBy(automations.nextRunAt);
    return rows.map(toRecord);
  },

  async markRan({ id, lastRunAt, nextRunAt }) {
    await db
      .update(automations)
      .set({ lastRunAt, nextRunAt, updatedAt: new Date() })
      .where(eq(automations.id, id));
  },

  async recordRun(input) {
    const [row] = await db
      .insert(automationRuns)
      .values({
        workspaceId: input.workspaceId,
        automationId: input.automationId,
        trigger: input.trigger,
        status: input.status,
        reason: input.reason,
        sessionId: input.sessionId,
        task: input.task,
      })
      .returning();
    return row as AutomationRun;
  },

  async countRunsInWindow(workspaceId, since) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.workspaceId, workspaceId),
          eq(automationRuns.status, "launched"),
          gte(automationRuns.createdAt, since),
        ),
      );
    return row?.n ?? 0;
  },

  async findByWebhookHash(hash) {
    const [row] = await db
      .select(A_COLUMNS)
      .from(automations)
      .where(and(eq(automations.webhookTokenHash, hash), eq(automations.enabled, true)))
      .limit(1);
    return row ? toRecord(row) : null;
  },

  async activeWorkspaces() {
    const rows = await db
      .selectDistinct({ workspaceId: automations.workspaceId })
      .from(automations)
      .where(and(eq(automations.enabled, true), eq(automations.triggerKind, "schedule")));
    return rows.map((r) => r.workspaceId);
  },
};

/** A workspace's run ledger, newest first (the audit-trail + console source). */
export async function listAutomationRuns(workspaceId: string, limit = 100): Promise<AutomationRun[]> {
  const rows = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.workspaceId, workspaceId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(limit);
  return rows as AutomationRun[];
}
