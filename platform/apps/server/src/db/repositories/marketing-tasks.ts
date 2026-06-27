import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { marketingTasks } from "../schema/index.js";

/**
 * Marketing department task records (#123). A thin repo over `marketing_tasks` — create a record when a
 * welcome brief or @mention launch fires, list a workspace's records for the team panel, and update a
 * record's status. Workspace-scoped reads carry the #3 IDOR boundary.
 */

export type MarketingTaskKind = "welcome" | "mention" | "discovery";
export type MarketingTaskStatus = "launched" | "done" | "failed" | "blocked";

export interface MarketingTask {
  id: string;
  workspaceId: string;
  channelId: string;
  department: string;
  agentMemberId: string;
  sessionId: string | null;
  messageId: string | null;
  kind: MarketingTaskKind;
  task: string;
  status: MarketingTaskStatus;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_MARKETING_TASK_LIST_LIMIT = 500;

export function clampMarketingTaskListLimit(limit?: number): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) return MAX_MARKETING_TASK_LIST_LIMIT;
  return Math.min(MAX_MARKETING_TASK_LIST_LIMIT, Math.floor(limit));
}

export async function createMarketingTask(input: {
  workspaceId: string;
  channelId: string;
  department: string;
  agentMemberId: string;
  sessionId?: string | null;
  messageId?: string | null;
  kind: MarketingTaskKind;
  task: string;
  createdByMemberId: string;
}): Promise<MarketingTask> {
  const [row] = await db
    .insert(marketingTasks)
    .values({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      department: input.department,
      agentMemberId: input.agentMemberId,
      sessionId: input.sessionId ?? null,
      messageId: input.messageId ?? null,
      kind: input.kind,
      task: input.task,
      status: "launched",
      createdByMemberId: input.createdByMemberId,
    })
    .returning();
  return row as MarketingTask;
}

/** A workspace's task records, newest first (the team panel's activity feed). */
export async function listMarketingTasks(workspaceId: string, limit?: number): Promise<MarketingTask[]> {
  const rows = await db
    .select()
    .from(marketingTasks)
    .where(eq(marketingTasks.workspaceId, workspaceId))
    .orderBy(desc(marketingTasks.createdAt))
    .limit(clampMarketingTaskListLimit(limit));
  return rows as MarketingTask[];
}

export async function countMarketingTasksByStatus(
  workspaceId: string,
  status: MarketingTaskStatus,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketingTasks)
    .where(and(eq(marketingTasks.workspaceId, workspaceId), eq(marketingTasks.status, status)));
  return row?.count ?? 0;
}

/**
 * The most recent task records for one department in a workspace, newest first, bounded — the SkillOpt-Sleep
 * harvest surface (#283, ADR-0283 Follow-up #1). Workspace + department scoped (the #3 IDOR boundary), so the
 * loop only ever reads the real briefs THAT agent ran. Bounded by `limit` to cap the harvested batch size.
 */
export async function listRecentMarketingTasksByDepartment(
  workspaceId: string,
  department: string,
  limit = 200,
): Promise<MarketingTask[]> {
  const rows = await db
    .select()
    .from(marketingTasks)
    .where(and(eq(marketingTasks.workspaceId, workspaceId), eq(marketingTasks.department, department)))
    .orderBy(desc(marketingTasks.createdAt))
    .limit(clampMarketingTaskListLimit(limit));
  return rows as MarketingTask[];
}

/** Update a record's status (workspace-scoped). */
export async function updateMarketingTaskStatus(
  id: string,
  workspaceId: string,
  status: MarketingTaskStatus,
): Promise<void> {
  await db
    .update(marketingTasks)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(marketingTasks.id, id), eq(marketingTasks.workspaceId, workspaceId)));
}
