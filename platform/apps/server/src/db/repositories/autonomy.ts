import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import {
  agentPools,
  agentPoolMembers,
  agentAutonomy,
  autonomyControls,
  agentWorkflows,
  agentApprovals,
  tasks,
  taskEvents,
  taskLinks,
} from "../schema/index.js";
import type { WorkflowStatus } from "../../autonomy/decide.js";

/**
 * Autonomy + pooling repository (#17, ADR-0017). Workspace-scoped throughout (the #3 IDOR
 * discipline). Pure decision/guard logic lives in `../../autonomy/*`; this is persistence only.
 */

// ---- pools ------------------------------------------------------------------

export interface AgentPool {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export interface PoolMember {
  id: string;
  poolId: string;
  agentMemberId: string;
  roles: string[];
  createdAt: Date;
}

export async function createPool(input: {
  workspaceId: string;
  name: string;
  description?: string | null;
  createdByMemberId: string;
}): Promise<AgentPool> {
  const [row] = await db
    .insert(agentPools)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
      createdByMemberId: input.createdByMemberId,
    })
    .returning({
      id: agentPools.id,
      workspaceId: agentPools.workspaceId,
      name: agentPools.name,
      description: agentPools.description,
      createdAt: agentPools.createdAt,
    });
  return row as AgentPool;
}

export async function listPools(workspaceId: string): Promise<AgentPool[]> {
  const rows = await db
    .select({
      id: agentPools.id,
      workspaceId: agentPools.workspaceId,
      name: agentPools.name,
      description: agentPools.description,
      createdAt: agentPools.createdAt,
    })
    .from(agentPools)
    .where(eq(agentPools.workspaceId, workspaceId))
    .orderBy(asc(agentPools.createdAt));
  return rows as AgentPool[];
}

export async function getPool(id: string, workspaceId: string): Promise<AgentPool | undefined> {
  const [row] = await db
    .select({
      id: agentPools.id,
      workspaceId: agentPools.workspaceId,
      name: agentPools.name,
      description: agentPools.description,
      createdAt: agentPools.createdAt,
    })
    .from(agentPools)
    .where(and(eq(agentPools.id, id), eq(agentPools.workspaceId, workspaceId)))
    .limit(1);
  return row as AgentPool | undefined;
}

/** Add an agent to a pool with its roles, or update the roles if already a member (idempotent). */
export async function addPoolMember(input: {
  workspaceId: string;
  poolId: string;
  agentMemberId: string;
  roles: string[];
}): Promise<PoolMember> {
  const [row] = await db
    .insert(agentPoolMembers)
    .values({
      workspaceId: input.workspaceId,
      poolId: input.poolId,
      agentMemberId: input.agentMemberId,
      roles: input.roles,
    })
    .onConflictDoUpdate({
      target: [agentPoolMembers.poolId, agentPoolMembers.agentMemberId],
      set: { roles: input.roles },
    })
    .returning({
      id: agentPoolMembers.id,
      poolId: agentPoolMembers.poolId,
      agentMemberId: agentPoolMembers.agentMemberId,
      roles: agentPoolMembers.roles,
      createdAt: agentPoolMembers.createdAt,
    });
  return row as PoolMember;
}

export async function listPoolMembers(poolId: string): Promise<PoolMember[]> {
  const rows = await db
    .select({
      id: agentPoolMembers.id,
      poolId: agentPoolMembers.poolId,
      agentMemberId: agentPoolMembers.agentMemberId,
      roles: agentPoolMembers.roles,
      createdAt: agentPoolMembers.createdAt,
    })
    .from(agentPoolMembers)
    .where(eq(agentPoolMembers.poolId, poolId))
    .orderBy(asc(agentPoolMembers.createdAt));
  return rows as PoolMember[];
}

/** The union of roles an agent fills across every pool it is in — "per its roles" (#17 AC3). */
export async function agentRoles(workspaceId: string, agentMemberId: string): Promise<string[]> {
  const rows = await db
    .select({ roles: agentPoolMembers.roles })
    .from(agentPoolMembers)
    .where(
      and(
        eq(agentPoolMembers.workspaceId, workspaceId),
        eq(agentPoolMembers.agentMemberId, agentMemberId),
      ),
    );
  return [...new Set(rows.flatMap((r) => r.roles))];
}

/** True iff the agent belongs to any pool in the workspace (i.e. is shareable). */
export async function isAgentPooled(workspaceId: string, agentMemberId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentPoolMembers.id })
    .from(agentPoolMembers)
    .where(
      and(
        eq(agentPoolMembers.workspaceId, workspaceId),
        eq(agentPoolMembers.agentMemberId, agentMemberId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ---- autonomy config (rate + cost guards) -----------------------------------

export interface AgentAutonomy {
  id: string;
  agentMemberId: string;
  enabled: boolean;
  maxActionsPerTick: number;
  actionBudget: number;
  actionsUsed: number;
}

const AUTONOMY_COLS = {
  id: agentAutonomy.id,
  agentMemberId: agentAutonomy.agentMemberId,
  enabled: agentAutonomy.enabled,
  maxActionsPerTick: agentAutonomy.maxActionsPerTick,
  actionBudget: agentAutonomy.actionBudget,
  actionsUsed: agentAutonomy.actionsUsed,
} as const;

/** Enable/configure an agent's autonomy (idempotent upsert). Never resets `actionsUsed`. */
export async function upsertAutonomy(input: {
  workspaceId: string;
  agentMemberId: string;
  enabled: boolean;
  maxActionsPerTick: number;
  actionBudget: number;
}): Promise<AgentAutonomy> {
  const [row] = await db
    .insert(agentAutonomy)
    .values({
      workspaceId: input.workspaceId,
      agentMemberId: input.agentMemberId,
      enabled: input.enabled,
      maxActionsPerTick: input.maxActionsPerTick,
      actionBudget: input.actionBudget,
    })
    .onConflictDoUpdate({
      target: [agentAutonomy.workspaceId, agentAutonomy.agentMemberId],
      set: {
        enabled: input.enabled,
        maxActionsPerTick: input.maxActionsPerTick,
        actionBudget: input.actionBudget,
        updatedAt: new Date(),
      },
    })
    .returning(AUTONOMY_COLS);
  return row as AgentAutonomy;
}

export async function getAutonomy(
  workspaceId: string,
  agentMemberId: string,
): Promise<AgentAutonomy | undefined> {
  const [row] = await db
    .select(AUTONOMY_COLS)
    .from(agentAutonomy)
    .where(
      and(
        eq(agentAutonomy.workspaceId, workspaceId),
        eq(agentAutonomy.agentMemberId, agentMemberId),
      ),
    )
    .limit(1);
  return row as AgentAutonomy | undefined;
}

/** Spend one (or more) action(s) of the agent's budget — the cost-guard accounting. */
export async function incrementActionsUsed(id: string, by = 1): Promise<void> {
  await db
    .update(agentAutonomy)
    .set({ actionsUsed: sql`${agentAutonomy.actionsUsed} + ${by}`, updatedAt: new Date() })
    .where(eq(agentAutonomy.id, id));
}

/**
 * Atomically reserve one (or more) action-budget slots. Returns false when the live row would exceed
 * its configured budget, so concurrent ticks cannot all pass a stale read and spend the same slot.
 */
export async function tryReserveActionsUsed(id: string, by = 1): Promise<boolean> {
  if (by <= 0) return true;
  const rows = await db
    .update(agentAutonomy)
    .set({ actionsUsed: sql`${agentAutonomy.actionsUsed} + ${by}`, updatedAt: new Date() })
    .where(
      and(
        eq(agentAutonomy.id, id),
        sql`${agentAutonomy.actionsUsed} + ${by} <= ${agentAutonomy.actionBudget}`,
      ),
    )
    .returning({ id: agentAutonomy.id });
  return rows.length > 0;
}

/** Compensate a reserved action slot when the action fails before it is actually applied. */
export async function refundActionsUsed(id: string, by = 1): Promise<void> {
  if (by <= 0) return;
  await db
    .update(agentAutonomy)
    .set({
      actionsUsed: sql`GREATEST(0, ${agentAutonomy.actionsUsed} - ${by})`,
      updatedAt: new Date(),
    })
    .where(eq(agentAutonomy.id, id));
}

// ---- controls (kill switch) -------------------------------------------------

export interface AutonomyControls {
  workspaceId: string;
  killSwitch: boolean;
}

/** The workspace's controls; defaults to kill-switch-off when no row exists yet. */
export async function getControls(workspaceId: string): Promise<AutonomyControls> {
  const [row] = await db
    .select({ workspaceId: autonomyControls.workspaceId, killSwitch: autonomyControls.killSwitch })
    .from(autonomyControls)
    .where(eq(autonomyControls.workspaceId, workspaceId))
    .limit(1);
  return row ?? { workspaceId, killSwitch: false };
}

/** Engage/disengage the kill switch (idempotent upsert). Effect is immediate (next tick halts). */
export async function setKillSwitch(
  workspaceId: string,
  killSwitch: boolean,
  updatedByMemberId: string,
): Promise<AutonomyControls> {
  const [row] = await db
    .insert(autonomyControls)
    .values({ workspaceId, killSwitch, updatedByMemberId })
    .onConflictDoUpdate({
      target: autonomyControls.workspaceId,
      set: { killSwitch, updatedByMemberId, updatedAt: new Date() },
    })
    .returning({
      workspaceId: autonomyControls.workspaceId,
      killSwitch: autonomyControls.killSwitch,
    });
  return row as AutonomyControls;
}

// ---- workflows --------------------------------------------------------------

export interface WorkflowStage {
  agentMemberId: string;
  role: string;
}

export interface AgentWorkflow {
  id: string;
  workspaceId: string;
  channelId: string;
  taskId: string;
  stages: WorkflowStage[];
  currentStage: number;
  status: WorkflowStatus;
  actionCount: number;
  currentSessionId: string | null;
  currentSessionStage: number | null;
  recurring: boolean;
  sourceWorkflowId: string | null;
  createdAt: Date;
}

const WORKFLOW_COLS = {
  id: agentWorkflows.id,
  workspaceId: agentWorkflows.workspaceId,
  channelId: agentWorkflows.channelId,
  taskId: agentWorkflows.taskId,
  stages: agentWorkflows.stages,
  currentStage: agentWorkflows.currentStage,
  status: agentWorkflows.status,
  actionCount: agentWorkflows.actionCount,
  currentSessionId: agentWorkflows.currentSessionId,
  currentSessionStage: agentWorkflows.currentSessionStage,
  recurring: agentWorkflows.recurring,
  sourceWorkflowId: agentWorkflows.sourceWorkflowId,
  createdAt: agentWorkflows.createdAt,
} as const;

export async function createWorkflow(input: {
  workspaceId: string;
  channelId: string;
  taskId: string;
  stages: WorkflowStage[];
  createdByMemberId: string;
  recurring?: boolean;
  sourceWorkflowId?: string | null;
}): Promise<AgentWorkflow> {
  const [row] = await db
    .insert(agentWorkflows)
    .values({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      taskId: input.taskId,
      stages: input.stages,
      createdByMemberId: input.createdByMemberId,
      recurring: input.recurring ?? false,
      sourceWorkflowId: input.sourceWorkflowId ?? null,
    })
    .returning(WORKFLOW_COLS);
  return row as AgentWorkflow;
}

export async function getWorkflow(
  id: string,
  workspaceId: string,
): Promise<AgentWorkflow | undefined> {
  const [row] = await db
    .select(WORKFLOW_COLS)
    .from(agentWorkflows)
    .where(and(eq(agentWorkflows.id, id), eq(agentWorkflows.workspaceId, workspaceId)))
    .limit(1);
  return row as AgentWorkflow | undefined;
}

export const MAX_AUTONOMY_LIST_LIMIT = 500;

export function clampAutonomyListLimit(limit?: number): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) return MAX_AUTONOMY_LIST_LIMIT;
  return Math.min(MAX_AUTONOMY_LIST_LIMIT, Math.floor(limit));
}

export async function listWorkflowsInChannel(
  channelId: string,
  limit?: number,
): Promise<AgentWorkflow[]> {
  const rows = await db
    .select(WORKFLOW_COLS)
    .from(agentWorkflows)
    .where(eq(agentWorkflows.channelId, channelId))
    .orderBy(desc(agentWorkflows.createdAt))
    .limit(clampAutonomyListLimit(limit));
  return rows as AgentWorkflow[];
}

/** The engine's work-list: every `running` workflow in a workspace, oldest first (fair order). */
export async function listActiveWorkflows(
  workspaceId: string,
  limit?: number,
): Promise<AgentWorkflow[]> {
  const rows = await db
    .select(WORKFLOW_COLS)
    .from(agentWorkflows)
    .where(and(eq(agentWorkflows.workspaceId, workspaceId), eq(agentWorkflows.status, "running")))
    .orderBy(asc(agentWorkflows.createdAt))
    .limit(clampAutonomyListLimit(limit));
  return rows as AgentWorkflow[];
}

/** Distinct workspaces that currently have a `running` workflow — the production timer's work-list. */
export async function listActiveWorkflowWorkspaces(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: agentWorkflows.workspaceId })
    .from(agentWorkflows)
    .where(eq(agentWorkflows.status, "running"));
  return rows.map((r) => r.workspaceId);
}

/** Advance the stage pointer and count one action (loop-guard accounting). Returns the new count. */
export async function advanceWorkflowStage(id: string, toStage: number): Promise<void> {
  await db
    .update(agentWorkflows)
    .set({
      currentStage: toStage,
      actionCount: sql`${agentWorkflows.actionCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(agentWorkflows.id, id));
}

export async function handoffWorkflowStage(input: {
  workflowId: string;
  expectedCurrentStage: number;
  toStage: number;
  taskId: string;
  workspaceId: string;
  nextAgentMemberId: string;
  actorMemberId: string;
  memoryId: string;
}): Promise<{ advanced: boolean; alreadyAdvanced: boolean }> {
  return db.transaction(async (tx) => {
    const [workflow] = await tx
      .select({ currentStage: agentWorkflows.currentStage, status: agentWorkflows.status })
      .from(agentWorkflows)
      .where(eq(agentWorkflows.id, input.workflowId))
      .limit(1);
    if (!workflow) return { advanced: false, alreadyAdvanced: false };
    if (workflow.currentStage === input.toStage) {
      return { advanced: false, alreadyAdvanced: workflow.status === "running" };
    }
    if (workflow.status !== "running" || workflow.currentStage !== input.expectedCurrentStage) {
      return { advanced: false, alreadyAdvanced: false };
    }

    const [advanced] = await tx
      .update(agentWorkflows)
      .set({
        currentStage: input.toStage,
        actionCount: sql`${agentWorkflows.actionCount} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentWorkflows.id, input.workflowId),
          eq(agentWorkflows.status, "running"),
          eq(agentWorkflows.currentStage, input.expectedCurrentStage),
        ),
      )
      .returning({ id: agentWorkflows.id });
    if (!advanced) return { advanced: false, alreadyAdvanced: false };

    const insertedLink = await tx
      .insert(taskLinks)
      .values({
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        targetType: "memory",
        targetId: input.memoryId,
        createdByMemberId: input.actorMemberId,
      })
      .onConflictDoNothing()
      .returning({ id: taskLinks.id });
    if (insertedLink.length > 0) {
      await tx.insert(taskEvents).values({
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        type: "linked",
        actorMemberId: input.actorMemberId,
        toValue: `memory:${input.memoryId}`,
      });
    }

    const [task] = await tx
      .select({ assigneeMemberId: tasks.assigneeMemberId })
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, input.workspaceId)))
      .limit(1);
    if (!task) throw new Error(`task ${input.taskId} not found`);
    if (task.assigneeMemberId !== input.nextAgentMemberId) {
      await tx
        .update(tasks)
        .set({ assigneeMemberId: input.nextAgentMemberId, updatedAt: new Date() })
        .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, input.workspaceId)));
      await tx.insert(taskEvents).values({
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        type: task.assigneeMemberId === null ? "assigned" : "reassigned",
        actorMemberId: input.actorMemberId,
        fromValue: task.assigneeMemberId,
        toValue: input.nextAgentMemberId,
      });
    }

    return { advanced: true, alreadyAdvanced: false };
  });
}

/** Count one action without moving the stage (start / request_approval). */
export async function bumpWorkflowAction(id: string): Promise<void> {
  await db
    .update(agentWorkflows)
    .set({ actionCount: sql`${agentWorkflows.actionCount} + 1`, updatedAt: new Date() })
    .where(eq(agentWorkflows.id, id));
}

export async function attachWorkflowSession(input: {
  workflowId: string;
  expectedCurrentStage: number;
  sessionId: string;
}): Promise<boolean> {
  const rows = await db
    .update(agentWorkflows)
    .set({
      currentSessionId: input.sessionId,
      currentSessionStage: input.expectedCurrentStage,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentWorkflows.id, input.workflowId),
        eq(agentWorkflows.status, "running"),
        eq(agentWorkflows.currentStage, input.expectedCurrentStage),
      ),
    )
    .returning({ id: agentWorkflows.id });
  return rows.length > 0;
}

export async function clearWorkflowSession(input: {
  workflowId: string;
  sessionId: string;
}): Promise<void> {
  await db
    .update(agentWorkflows)
    .set({ currentSessionId: null, currentSessionStage: null, updatedAt: new Date() })
    .where(
      and(
        eq(agentWorkflows.id, input.workflowId),
        eq(agentWorkflows.currentSessionId, input.sessionId),
      ),
    );
}

export async function setWorkflowStatus(id: string, status: WorkflowStatus): Promise<void> {
  await db
    .update(agentWorkflows)
    .set({ status, updatedAt: new Date() })
    .where(eq(agentWorkflows.id, id));
}

export async function markWorkflowAwaitingApproval(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [workflow] = await tx
      .select({ status: agentWorkflows.status })
      .from(agentWorkflows)
      .where(eq(agentWorkflows.id, id))
      .limit(1);
    if (!workflow || workflow.status !== "running") return;
    await tx
      .update(agentWorkflows)
      .set({
        status: "awaiting_approval",
        actionCount: sql`${agentWorkflows.actionCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(agentWorkflows.id, id));
  });
}

export async function completeWorkflowWithTask(input: {
  workflowId: string;
  taskId: string;
  actorMemberId: string;
  completeTask: boolean;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [workflow] = await tx
      .select({ status: agentWorkflows.status })
      .from(agentWorkflows)
      .where(eq(agentWorkflows.id, input.workflowId))
      .limit(1);
    if (!workflow || workflow.status === "completed") return;

    const [task] = await tx
      .select({ workspaceId: tasks.workspaceId, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1);
    if (!task) throw new Error(`task ${input.taskId} not found`);

    if (input.completeTask && task.status !== "done") {
      await tx
        .update(tasks)
        .set({ status: "done", updatedAt: new Date() })
        .where(eq(tasks.id, input.taskId));
      await tx.insert(taskEvents).values({
        workspaceId: task.workspaceId,
        taskId: input.taskId,
        type: "status_changed",
        actorMemberId: input.actorMemberId,
        fromValue: task.status,
        toValue: "done",
      });
    }

    await tx
      .update(agentWorkflows)
      .set({
        status: "completed",
        actionCount: sql`${agentWorkflows.actionCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(agentWorkflows.id, input.workflowId));
  });
}

export async function spawnRecurringWorkflowSuccessor(input: {
  workflowId: string;
  completedTaskTitle: string;
  actorMemberId: string;
}): Promise<AgentWorkflow | undefined> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select(WORKFLOW_COLS)
      .from(agentWorkflows)
      .where(eq(agentWorkflows.sourceWorkflowId, input.workflowId))
      .limit(1);
    if (existing) return existing as AgentWorkflow;

    const [workflow] = await tx
      .select(WORKFLOW_COLS)
      .from(agentWorkflows)
      .where(eq(agentWorkflows.id, input.workflowId))
      .limit(1);
    const wf = workflow as AgentWorkflow | undefined;
    if (!wf || !wf.recurring || wf.status !== "completed" || wf.stages.length === 0) {
      return undefined;
    }

    const firstStage = wf.stages[0]!;
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId: wf.workspaceId,
        title: "Next: " + input.completedTaskTitle,
        description: "Auto-spawned by recurring autonomy workflow " + wf.id + ".",
        labels: ["autonomy", "recurring"],
        assigneeMemberId: firstStage.agentMemberId,
        createdByMemberId: input.actorMemberId,
      })
      .returning({ id: tasks.id });
    if (!task) return undefined;
    await tx.insert(taskEvents).values({
      workspaceId: wf.workspaceId,
      taskId: task.id,
      type: "created",
      actorMemberId: input.actorMemberId,
      toValue: "backlog",
      detail: { sourceWorkflowId: wf.id },
    });
    await tx.insert(taskEvents).values({
      workspaceId: wf.workspaceId,
      taskId: task.id,
      type: "assigned",
      actorMemberId: input.actorMemberId,
      toValue: firstStage.agentMemberId,
      detail: { sourceWorkflowId: wf.id },
    });

    const [successor] = await tx
      .insert(agentWorkflows)
      .values({
        workspaceId: wf.workspaceId,
        channelId: wf.channelId,
        taskId: task.id,
        stages: wf.stages,
        createdByMemberId: input.actorMemberId,
        recurring: true,
        sourceWorkflowId: wf.id,
      })
      .returning(WORKFLOW_COLS);
    return successor as AgentWorkflow | undefined;
  });
}

// ---- approvals (the human gate) ---------------------------------------------

export interface AgentApproval {
  id: string;
  workspaceId: string;
  workflowId: string | null;
  taskId: string;
  requestedByMemberId: string | null;
  action: string;
  status: "pending" | "approved" | "rejected";
  decidedByMemberId: string | null;
  /** Who closed the gate — a human reviewer or an auto-approve policy rule (#84 follow-up). */
  decisionSource: "human" | "policy";
  /** The `approval_policies` rule that auto-approved the gate (audit); null for human decisions. */
  policyRuleId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

const APPROVAL_COLS = {
  id: agentApprovals.id,
  workspaceId: agentApprovals.workspaceId,
  workflowId: agentApprovals.workflowId,
  taskId: agentApprovals.taskId,
  requestedByMemberId: agentApprovals.requestedByMemberId,
  action: agentApprovals.action,
  status: agentApprovals.status,
  decidedByMemberId: agentApprovals.decidedByMemberId,
  decisionSource: agentApprovals.decisionSource,
  policyRuleId: agentApprovals.policyRuleId,
  createdAt: agentApprovals.createdAt,
  decidedAt: agentApprovals.decidedAt,
} as const;

export async function createApproval(input: {
  workspaceId: string;
  workflowId: string;
  taskId: string;
  requestedByMemberId: string;
  action: string;
}): Promise<AgentApproval> {
  const [row] = await db
    .insert(agentApprovals)
    .values({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      taskId: input.taskId,
      requestedByMemberId: input.requestedByMemberId,
      action: input.action,
    })
    .returning(APPROVAL_COLS);
  return row as AgentApproval;
}

export async function findWorkflowApproval(input: {
  workspaceId: string;
  workflowId: string;
  taskId: string;
  action: string;
}): Promise<AgentApproval | undefined> {
  const [row] = await db
    .select(APPROVAL_COLS)
    .from(agentApprovals)
    .where(
      and(
        eq(agentApprovals.workspaceId, input.workspaceId),
        eq(agentApprovals.workflowId, input.workflowId),
        eq(agentApprovals.taskId, input.taskId),
        eq(agentApprovals.action, input.action),
      ),
    )
    .orderBy(desc(agentApprovals.createdAt))
    .limit(1);
  return row as AgentApproval | undefined;
}

export async function getApproval(
  id: string,
  workspaceId: string,
): Promise<AgentApproval | undefined> {
  const [row] = await db
    .select(APPROVAL_COLS)
    .from(agentApprovals)
    .where(and(eq(agentApprovals.id, id), eq(agentApprovals.workspaceId, workspaceId)))
    .limit(1);
  return row as AgentApproval | undefined;
}

export async function listApprovals(
  workspaceId: string,
  filter: { status?: "pending" | "approved" | "rejected"; limit?: number } = {},
): Promise<AgentApproval[]> {
  const where = [eq(agentApprovals.workspaceId, workspaceId)];
  if (filter.status) where.push(eq(agentApprovals.status, filter.status));
  const rows = await db
    .select(APPROVAL_COLS)
    .from(agentApprovals)
    .where(and(...where))
    .orderBy(desc(agentApprovals.createdAt))
    .limit(clampAutonomyListLimit(filter.limit));
  return rows as AgentApproval[];
}

/**
 * Record a decision on a pending approval (idempotent on the pending→decided edge): only a
 * still-`pending` row is updated, so a double-approve/reject is a no-op. Returns the updated row,
 * or undefined if it was not pending.
 *
 * A human decision passes `decidedByMemberId` and leaves `decisionSource` at its default `'human'`.
 * A policy auto-approval (#84 follow-up, ADR-0042) passes `decisionSource: 'policy'` + the
 * `policyRuleId` that fired (the audit anchor) and may leave `decidedByMemberId` null — no human acted.
 */
export async function decideApproval(
  id: string,
  decision: {
    status: "approved" | "rejected";
    decidedByMemberId: string | null;
    decisionSource?: "human" | "policy";
    policyRuleId?: string | null;
  },
): Promise<AgentApproval | undefined> {
  const [row] = await db
    .update(agentApprovals)
    .set({
      status: decision.status,
      decidedByMemberId: decision.decidedByMemberId,
      decisionSource: decision.decisionSource ?? "human",
      policyRuleId: decision.policyRuleId ?? null,
      decidedAt: new Date(),
    })
    .where(and(eq(agentApprovals.id, id), eq(agentApprovals.status, "pending")))
    .returning(APPROVAL_COLS);
  return row as AgentApproval | undefined;
}
