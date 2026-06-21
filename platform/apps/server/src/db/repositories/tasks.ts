import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../index.js";
import {
  tasks,
  taskEvents,
  taskLinks,
  taskDependencies,
  taskRoutingRules,
  members,
  agents,
} from "../schema/index.js";
import { selectLeastLoaded } from "../../tasks/routing.js";
import { wouldCreateCycle } from "../../tasks/dependencies.js";
import type { TaskStatus } from "../../tasks/status.js";

/** Statuses that don't count toward an assignee's open-task load (round-robin input). */
const TERMINAL: TaskStatus[] = ["done", "canceled"];

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  labels: string[];
  assigneeMemberId: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: string;
  actorMemberId: string | null;
  fromValue: string | null;
  toValue: string | null;
  createdAt: Date;
}

export interface TaskLink {
  id: string;
  taskId: string;
  targetType: string;
  targetId: string;
  createdAt: Date;
}

export interface RoutingRule {
  id: string;
  label: string;
  agentMemberId: string;
  createdAt: Date;
}

const TASK_COLUMNS = {
  id: tasks.id,
  workspaceId: tasks.workspaceId,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  labels: tasks.labels,
  assigneeMemberId: tasks.assigneeMemberId,
  createdByMemberId: tasks.createdByMemberId,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
} as const;

// ---- tasks CRUD + status ----------------------------------------------------

/** Create a task and record the opening events (`created`, plus `assigned` if pre-assigned). */
export async function createTask(input: {
  workspaceId: string;
  title: string;
  description?: string | null;
  labels?: string[];
  createdByMemberId: string;
  assigneeMemberId?: string | null;
}): Promise<Task> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tasks)
      .values({
        workspaceId: input.workspaceId,
        title: input.title,
        description: input.description ?? null,
        labels: input.labels ?? [],
        createdByMemberId: input.createdByMemberId,
        assigneeMemberId: input.assigneeMemberId ?? null,
      })
      .returning(TASK_COLUMNS);
    const task = row as Task;
    await tx.insert(taskEvents).values({
      workspaceId: task.workspaceId,
      taskId: task.id,
      type: "created",
      actorMemberId: input.createdByMemberId,
      toValue: task.status,
    });
    if (task.assigneeMemberId) {
      await tx.insert(taskEvents).values({
        workspaceId: task.workspaceId,
        taskId: task.id,
        type: "assigned",
        actorMemberId: input.createdByMemberId,
        toValue: task.assigneeMemberId,
      });
    }
    return task;
  });
}

export async function getTask(id: string): Promise<Task | undefined> {
  const [row] = await db.select(TASK_COLUMNS).from(tasks).where(eq(tasks.id, id)).limit(1);
  return row as Task | undefined;
}

/** Tasks in a workspace, optionally filtered by status and/or assignee (the by-assignee view). */
export async function listTasks(
  workspaceId: string,
  filters: { status?: TaskStatus; assigneeMemberId?: string } = {},
): Promise<Task[]> {
  const where = [eq(tasks.workspaceId, workspaceId)];
  if (filters.status) where.push(eq(tasks.status, filters.status));
  if (filters.assigneeMemberId) where.push(eq(tasks.assigneeMemberId, filters.assigneeMemberId));
  const rows = await db
    .select(TASK_COLUMNS)
    .from(tasks)
    .where(and(...where))
    .orderBy(asc(tasks.createdAt));
  return rows as Task[];
}

/** Board view: every workspace task grouped by status (empty buckets included). */
export async function boardView(workspaceId: string): Promise<Record<TaskStatus, Task[]>> {
  const all = await listTasks(workspaceId);
  const board = {
    backlog: [],
    todo: [],
    in_progress: [],
    blocked: [],
    done: [],
    canceled: [],
  } as Record<TaskStatus, Task[]>;
  for (const t of all) board[t.status].push(t);
  return board;
}

/** Apply a (pre-validated) status transition and append a `status_changed` event. */
export async function updateStatus(
  taskId: string,
  toStatus: TaskStatus,
  actorMemberId: string,
): Promise<Task> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: tasks.status, workspaceId: tasks.workspaceId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    const [row] = await tx
      .update(tasks)
      .set({ status: toStatus, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning(TASK_COLUMNS);
    await tx.insert(taskEvents).values({
      workspaceId: current!.workspaceId,
      taskId,
      type: "status_changed",
      actorMemberId,
      fromValue: current!.status,
      toValue: toStatus,
    });
    return row as Task;
  });
}

/**
 * Set (or clear) the assignee and append the right event by old→new:
 *   null→x = assigned, x→y = reassigned, x→null = unassigned. Same→same is a no-op (no event).
 */
export async function assignTask(
  taskId: string,
  newAssignee: string | null,
  actorMemberId: string,
): Promise<Task> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ assignee: tasks.assigneeMemberId, workspaceId: tasks.workspaceId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    const prev = current!.assignee;
    const [row] = await tx
      .update(tasks)
      .set({ assigneeMemberId: newAssignee, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning(TASK_COLUMNS);
    const task = row as Task;
    if (prev === newAssignee) return task; // no-op: nothing changed, no event
    const type = prev === null ? "assigned" : newAssignee === null ? "unassigned" : "reassigned";
    await tx.insert(taskEvents).values({
      workspaceId: current!.workspaceId,
      taskId,
      type,
      actorMemberId,
      fromValue: prev,
      toValue: newAssignee,
    });
    return task;
  });
}

/** A memory/message artifact handed over alongside a task (validated in-workspace at the route). */
export interface HandoffLink {
  targetType: string;
  targetId: string;
}

/**
 * Explicit handoff (#515): reassign a task to `toMemberId` and, in the SAME transaction, record a
 * single `handoff` event (carrying the optional note + from/to assignee) and attach any artifact
 * links the sender passes along. "Reassignment IS the handoff" — one audited act, so the chain of
 * who-held-what is never lost. Notifying the new assignee is the route's job (best-effort, #8).
 */
export async function handoffTask(input: {
  taskId: string;
  toMemberId: string;
  actorMemberId: string;
  note?: string | null;
  links?: HandoffLink[];
}): Promise<Task> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ assignee: tasks.assigneeMemberId, workspaceId: tasks.workspaceId })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1);
    const prev = current!.assignee;
    const wid = current!.workspaceId;
    const [row] = await tx
      .update(tasks)
      .set({ assigneeMemberId: input.toMemberId, updatedAt: new Date() })
      .where(eq(tasks.id, input.taskId))
      .returning(TASK_COLUMNS);
    await tx.insert(taskEvents).values({
      workspaceId: wid,
      taskId: input.taskId,
      type: "handoff",
      actorMemberId: input.actorMemberId,
      fromValue: prev,
      toValue: input.toMemberId,
      detail: input.note ? { note: input.note } : {},
    });
    for (const link of input.links ?? []) {
      const inserted = await tx
        .insert(taskLinks)
        .values({
          workspaceId: wid,
          taskId: input.taskId,
          targetType: link.targetType,
          targetId: link.targetId,
          createdByMemberId: input.actorMemberId,
        })
        .onConflictDoNothing()
        .returning({ id: taskLinks.id });
      if (inserted.length > 0) {
        await tx.insert(taskEvents).values({
          workspaceId: wid,
          taskId: input.taskId,
          type: "linked",
          actorMemberId: input.actorMemberId,
          toValue: `${link.targetType}:${link.targetId}`,
        });
      }
    }
    return row as Task;
  });
}

/** Full event history (chronological). Assignment history = the assign/reassign/unassign rows. */
export async function listTaskEvents(taskId: string): Promise<TaskEvent[]> {
  const rows = await db
    .select({
      id: taskEvents.id,
      taskId: taskEvents.taskId,
      type: taskEvents.type,
      actorMemberId: taskEvents.actorMemberId,
      fromValue: taskEvents.fromValue,
      toValue: taskEvents.toValue,
      createdAt: taskEvents.createdAt,
    })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.createdAt), asc(taskEvents.id));
  return rows as TaskEvent[];
}

// ---- links (resolve both ways) ----------------------------------------------

/** Link a task to a target object (idempotent). Appends a `linked` event only on a new link. */
export async function addTaskLink(input: {
  workspaceId: string;
  taskId: string;
  targetType: string;
  targetId: string;
  createdByMemberId: string;
}): Promise<{ created: boolean }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(taskLinks)
      .values({
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        targetType: input.targetType,
        targetId: input.targetId,
        createdByMemberId: input.createdByMemberId,
      })
      .onConflictDoNothing()
      .returning({ id: taskLinks.id });
    if (inserted.length === 0) return { created: false };
    await tx.insert(taskEvents).values({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      type: "linked",
      actorMemberId: input.createdByMemberId,
      toValue: `${input.targetType}:${input.targetId}`,
    });
    return { created: true };
  });
}

/** Remove a link. Appends an `unlinked` event only if a link was actually removed. */
export async function removeTaskLink(
  taskId: string,
  targetType: string,
  targetId: string,
  actorMemberId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({ workspaceId: tasks.workspaceId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    const deleted = await tx
      .delete(taskLinks)
      .where(
        and(
          eq(taskLinks.taskId, taskId),
          eq(taskLinks.targetType, targetType),
          eq(taskLinks.targetId, targetId),
        ),
      )
      .returning({ id: taskLinks.id });
    if (deleted.length === 0) return false;
    await tx.insert(taskEvents).values({
      workspaceId: task!.workspaceId,
      taskId,
      type: "unlinked",
      actorMemberId,
      fromValue: `${targetType}:${targetId}`,
    });
    return true;
  });
}

/** Forward resolution: the objects a task links to. */
export async function listTaskLinks(taskId: string): Promise<TaskLink[]> {
  const rows = await db
    .select({
      id: taskLinks.id,
      taskId: taskLinks.taskId,
      targetType: taskLinks.targetType,
      targetId: taskLinks.targetId,
      createdAt: taskLinks.createdAt,
    })
    .from(taskLinks)
    .where(eq(taskLinks.taskId, taskId))
    .orderBy(asc(taskLinks.createdAt));
  return rows as TaskLink[];
}

/** Reverse resolution: the tasks that link to a given object (workspace-scoped). */
export async function listTasksLinkingTo(
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<Task[]> {
  const rows = await db
    .select(TASK_COLUMNS)
    .from(taskLinks)
    .innerJoin(tasks, eq(tasks.id, taskLinks.taskId))
    .where(
      and(
        eq(taskLinks.workspaceId, workspaceId),
        eq(taskLinks.targetType, targetType),
        eq(taskLinks.targetId, targetId),
      ),
    )
    .orderBy(asc(tasks.createdAt));
  return rows as Task[];
}

// ---- dependencies / blockers (#515) -----------------------------------------

/** Outcome of adding an edge: created (or already existed), or rejected because it forms a cycle. */
export type AddDependencyResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "cycle" };

/** Load the workspace's depends-on adjacency (blocked → [blockers]) for the acyclic guard. */
async function loadDependsOnGraph(workspaceId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ blocked: taskDependencies.blockedTaskId, blocker: taskDependencies.blockerTaskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.workspaceId, workspaceId));
  const graph = new Map<string, string[]>();
  for (const r of rows) {
    const list = graph.get(r.blocked) ?? [];
    list.push(r.blocker);
    graph.set(r.blocked, list);
  }
  return graph;
}

/**
 * Add a dependency: `blockedTaskId` now waits on `blockerTaskId`. Both tasks are assumed already
 * validated in `workspaceId` (the route does the IDOR check). Rejects edges that would create a
 * cycle; the insert is idempotent (UNIQUE) and records a `dependency_added` event only when new.
 */
export async function addDependency(input: {
  workspaceId: string;
  blockedTaskId: string;
  blockerTaskId: string;
  createdByMemberId: string;
}): Promise<AddDependencyResult> {
  const graph = await loadDependsOnGraph(input.workspaceId);
  if (wouldCreateCycle(graph, input.blockedTaskId, input.blockerTaskId)) {
    return { ok: false, reason: "cycle" };
  }
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(taskDependencies)
      .values({
        workspaceId: input.workspaceId,
        blockedTaskId: input.blockedTaskId,
        blockerTaskId: input.blockerTaskId,
        createdByMemberId: input.createdByMemberId,
      })
      .onConflictDoNothing()
      .returning({ id: taskDependencies.id });
    if (inserted.length === 0) return { ok: true, created: false };
    await tx.insert(taskEvents).values({
      workspaceId: input.workspaceId,
      taskId: input.blockedTaskId,
      type: "dependency_added",
      actorMemberId: input.createdByMemberId,
      toValue: input.blockerTaskId,
    });
    return { ok: true, created: true };
  });
}

/** Remove a dependency edge. Records `dependency_removed` only when an edge was actually deleted. */
export async function removeDependency(
  blockedTaskId: string,
  blockerTaskId: string,
  actorMemberId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({ workspaceId: tasks.workspaceId })
      .from(tasks)
      .where(eq(tasks.id, blockedTaskId))
      .limit(1);
    const deleted = await tx
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.blockedTaskId, blockedTaskId),
          eq(taskDependencies.blockerTaskId, blockerTaskId),
        ),
      )
      .returning({ id: taskDependencies.id });
    if (deleted.length === 0) return false;
    await tx.insert(taskEvents).values({
      workspaceId: task!.workspaceId,
      taskId: blockedTaskId,
      type: "dependency_removed",
      actorMemberId,
      fromValue: blockerTaskId,
    });
    return true;
  });
}

/** The tasks that block `taskId` (its blockers). */
export async function listBlockers(taskId: string): Promise<Task[]> {
  const rows = await db
    .select(TASK_COLUMNS)
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.blockerTaskId))
    .where(eq(taskDependencies.blockedTaskId, taskId))
    .orderBy(asc(tasks.createdAt));
  return rows as Task[];
}

/** The tasks `taskId` blocks (its dependents). */
export async function listDependents(taskId: string): Promise<Task[]> {
  const rows = await db
    .select(TASK_COLUMNS)
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.blockedTaskId))
    .where(eq(taskDependencies.blockerTaskId, taskId))
    .orderBy(asc(tasks.createdAt));
  return rows as Task[];
}

/** Just the statuses of `taskId`'s blockers — the input the start-guard counts unsatisfied ones from. */
export async function getBlockerStatuses(taskId: string): Promise<TaskStatus[]> {
  const rows = await db
    .select({ status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.blockerTaskId))
    .where(eq(taskDependencies.blockedTaskId, taskId));
  return rows.map((r) => r.status as TaskStatus);
}

// ---- auto-routing rules + selection -----------------------------------------

export async function createRoutingRule(input: {
  workspaceId: string;
  label: string;
  agentMemberId: string;
  createdByMemberId: string;
}): Promise<RoutingRule> {
  const [row] = await db
    .insert(taskRoutingRules)
    .values({
      workspaceId: input.workspaceId,
      label: input.label,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
    })
    .onConflictDoNothing()
    .returning({
      id: taskRoutingRules.id,
      label: taskRoutingRules.label,
      agentMemberId: taskRoutingRules.agentMemberId,
      createdAt: taskRoutingRules.createdAt,
    });
  // On conflict the rule already exists; return the existing row so create is idempotent.
  if (row) return row as RoutingRule;
  const [existing] = await db
    .select({
      id: taskRoutingRules.id,
      label: taskRoutingRules.label,
      agentMemberId: taskRoutingRules.agentMemberId,
      createdAt: taskRoutingRules.createdAt,
    })
    .from(taskRoutingRules)
    .where(
      and(
        eq(taskRoutingRules.workspaceId, input.workspaceId),
        eq(taskRoutingRules.label, input.label),
        eq(taskRoutingRules.agentMemberId, input.agentMemberId),
      ),
    )
    .limit(1);
  return existing as RoutingRule;
}

export async function listRoutingRules(workspaceId: string): Promise<RoutingRule[]> {
  const rows = await db
    .select({
      id: taskRoutingRules.id,
      label: taskRoutingRules.label,
      agentMemberId: taskRoutingRules.agentMemberId,
      createdAt: taskRoutingRules.createdAt,
    })
    .from(taskRoutingRules)
    .where(eq(taskRoutingRules.workspaceId, workspaceId))
    .orderBy(asc(taskRoutingRules.createdAt));
  return rows as RoutingRule[];
}

export async function deleteRoutingRule(id: string, workspaceId: string): Promise<boolean> {
  const deleted = await db
    .delete(taskRoutingRules)
    .where(and(eq(taskRoutingRules.id, id), eq(taskRoutingRules.workspaceId, workspaceId)))
    .returning({ id: taskRoutingRules.id });
  return deleted.length > 0;
}

/**
 * Pick the agent a task should auto-route to: eligible agents = active agent members targeted
 * by a rule whose label ∈ the task's labels; among them, the least-loaded wins (round-robin).
 * Returns null when no rule matches (auto-route is a best-effort assist, never an error).
 */
export async function pickRouteAssignee(
  workspaceId: string,
  labels: string[],
): Promise<string | null> {
  if (labels.length === 0) return null;

  const ruleRows = await db
    .selectDistinct({ memberId: taskRoutingRules.agentMemberId })
    .from(taskRoutingRules)
    .innerJoin(members, eq(members.id, taskRoutingRules.agentMemberId))
    .leftJoin(agents, eq(agents.id, members.agentId))
    .where(
      and(
        eq(taskRoutingRules.workspaceId, workspaceId),
        inArray(taskRoutingRules.label, labels),
        eq(members.kind, "agent"),
        isNull(agents.deactivatedAt),
      ),
    );
  const eligible = ruleRows.map((r) => r.memberId);
  if (eligible.length === 0) return null;

  const loadRows = await db
    .select({
      assigneeMemberId: tasks.assigneeMemberId,
      openTasks: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        inArray(tasks.assigneeMemberId, eligible),
        notInArray(tasks.status, TERMINAL),
      ),
    )
    .groupBy(tasks.assigneeMemberId);
  const loadByMember = new Map(loadRows.map((r) => [r.assigneeMemberId, r.openTasks]));

  return selectLeastLoaded(
    eligible.map((memberId) => ({ memberId, openTasks: loadByMember.get(memberId) ?? 0 })),
  );
}
