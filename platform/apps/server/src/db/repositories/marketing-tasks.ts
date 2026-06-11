import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { marketingTasks } from "../schema/index.js";

/**
 * Marketing department task records (#123). A thin repo over `marketing_tasks` — create a record when a
 * welcome brief or @mention launch fires, list a workspace's records for the team panel, and update a
 * record's status. Workspace-scoped reads carry the #3 IDOR boundary.
 */

export type MarketingTaskKind = "welcome" | "mention";
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
export async function listMarketingTasks(workspaceId: string): Promise<MarketingTask[]> {
  const rows = await db
    .select()
    .from(marketingTasks)
    .where(eq(marketingTasks.workspaceId, workspaceId))
    .orderBy(desc(marketingTasks.createdAt));
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
