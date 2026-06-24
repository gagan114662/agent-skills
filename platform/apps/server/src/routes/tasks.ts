import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { requireTaskInWorkspace } from "../auth/access.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { notify } from "../notifications/service.js";
import type { Identity } from "../auth/identity.js";
import { messageInWorkspace } from "../db/repositories/messages.js";
import { memoryInWorkspace } from "../db/repositories/memories.js";
import { canTransition, isStatus, type TaskStatus } from "../tasks/status.js";
import { unsatisfiedBlockerCount } from "../tasks/dependencies.js";
import {
  createTask,
  getTask,
  listTasks,
  boardView,
  updateStatus,
  assignTask,
  handoffTask,
  listTaskEvents,
  addTaskLink,
  removeTaskLink,
  listTaskLinks,
  listTasksLinkingTo,
  addDependency,
  removeDependency,
  listBlockers,
  listDependents,
  getBlockerStatuses,
  createRoutingRule,
  listRoutingRules,
  deleteRoutingRule,
  pickRouteAssignee,
  TaskNotFoundError,
  type Task,
  type HandoffLink,
} from "../db/repositories/tasks.js";

/**
 * Assign a task and, if the assignee actually changed to a real member, fire an `assignment`
 * notification for them (#8). `notify` no-ops when the new assignee is the actor, and is
 * best-effort, so this never fails the assignment write.
 */
async function assignAndNotify(
  req: FastifyRequest,
  id: Identity,
  task: Task,
  newAssignee: string | null,
): Promise<Task> {
  const updated = await assignTask(task.id, newAssignee, id.memberId);
  if (newAssignee && newAssignee !== task.assigneeMemberId) {
    await notify(req.log, {
      workspaceId: task.workspaceId,
      recipientMemberId: newAssignee,
      type: "assignment",
      actorMemberId: id.memberId,
      taskId: task.id,
      excerpt: task.title,
    });
  }
  return updated;
}

function taskWriteNotFound(err: unknown, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  if (err instanceof TaskNotFoundError) return reply.code(404).send({ error: "task not found" });
  throw err;
}

/** Link targets #14 supports today (both workspace-validated). `file` joins when files land. */
const LINK_TYPES = ["message", "memory"] as const;
type LinkType = (typeof LINK_TYPES)[number];

function sanitizeLabels(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((l): l is string => typeof l === "string") : [];
}

/** True iff `targetId` is a real object of `type` in `workspaceId` (the link IDOR guard). */
async function targetInWorkspace(
  type: LinkType,
  targetId: string,
  workspaceId: string,
): Promise<boolean> {
  return type === "message"
    ? messageInWorkspace(targetId, workspaceId)
    : memoryInWorkspace(targetId, workspaceId);
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  // create a task; assignee precedence: explicit assigneeMemberId > autoRoute > unassigned
  app.post("/workspaces/:wid/tasks", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = req.body as {
      title?: string;
      description?: string;
      labels?: unknown;
      assigneeMemberId?: string;
      autoRoute?: boolean;
    };
    if (!b.title) return reply.code(400).send({ error: "title required" });
    const labels = sanitizeLabels(b.labels);

    let assignee: string | null = null;
    if (b.assigneeMemberId) {
      if (!(await getWorkspaceMember(b.assigneeMemberId, wid))) {
        return reply.code(404).send({ error: "assignee not found in this workspace" });
      }
      assignee = b.assigneeMemberId;
    } else if (b.autoRoute === true) {
      assignee = await pickRouteAssignee(wid, labels); // best-effort: null → unassigned
    }

    const task = await createTask({
      workspaceId: wid,
      title: b.title,
      description: b.description ?? null,
      labels,
      createdByMemberId: id.memberId,
      assigneeMemberId: assignee,
    });
    // #8: a task created already assigned notifies its assignee (notify no-ops for self-assign).
    if (task.assigneeMemberId) {
      await notify(req.log, {
        workspaceId: wid,
        recipientMemberId: task.assigneeMemberId,
        type: "assignment",
        actorMemberId: id.memberId,
        taskId: task.id,
        excerpt: task.title,
      });
    }
    return reply.code(201).send(task);
  });

  // list tasks; ?status= filters the board column, ?assignee= is the by-assignee view
  app.get("/workspaces/:wid/tasks", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { status?: string; assignee?: string };
    if (q.status && !isStatus(q.status)) {
      return reply.code(400).send({ error: "invalid status filter" });
    }
    return listTasks(wid, {
      status: q.status as TaskStatus | undefined,
      assigneeMemberId: q.assignee,
    });
  });

  // board view: tasks grouped by status
  app.get("/workspaces/:wid/tasks/board", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return boardView(wid);
  });

  app.get("/tasks/:tid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid } = req.params as { tid: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    return task;
  });

  // status transition (validated lifecycle; records a status_changed event)
  app.patch("/tasks/:tid/status", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid } = req.params as { tid: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    const b = req.body as { status?: string };
    if (!b.status || !isStatus(b.status)) {
      return reply.code(400).send({ error: "valid status required" });
    }
    if (!canTransition(task.status, b.status)) {
      return reply
        .code(409)
        .send({ error: `cannot transition from ${task.status} to ${b.status}` });
    }
    // #515: a task can't START while it still has open blockers (done/canceled blockers are satisfied).
    if (b.status === "in_progress") {
      const open = unsatisfiedBlockerCount(await getBlockerStatuses(tid));
      if (open > 0) {
        return reply
          .code(409)
          .send({ error: `blocked by ${open} unfinished task${open === 1 ? "" : "s"}` });
      }
    }
    try {
      return await updateStatus(tid, b.status, id.memberId);
    } catch (err) {
      return taskWriteNotFound(err, reply);
    }
  });

  // assign / reassign / unassign / auto-route (records the matching event)
  app.post("/tasks/:tid/assign", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid } = req.params as { tid: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    const b = req.body as { assigneeMemberId?: string | null; autoRoute?: boolean };

    if (b.autoRoute === true) {
      const target = await pickRouteAssignee(task.workspaceId, task.labels);
      if (target === null) return task; // best-effort: no rule matched, leave as-is
      try {
        return await assignAndNotify(req, id, task, target);
      } catch (err) {
        return taskWriteNotFound(err, reply);
      }
    }
    if (!("assigneeMemberId" in b)) {
      return reply.code(400).send({ error: "provide assigneeMemberId or autoRoute" });
    }
    if (b.assigneeMemberId) {
      if (!(await getWorkspaceMember(b.assigneeMemberId, task.workspaceId))) {
        return reply.code(404).send({ error: "assignee not found in this workspace" });
      }
    }
    try {
      return await assignAndNotify(req, id, task, b.assigneeMemberId ?? null);
    } catch (err) {
      return taskWriteNotFound(err, reply);
    }
  });

  // explicit handoff (#515): reassign to another member + a handoff note + optional artifact links.
  // Reassignment IS the handoff — one audited act, recorded as a single `handoff` event.
  app.post("/tasks/:tid/handoff", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid } = req.params as { tid: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    const b = req.body as { toMemberId?: string; note?: string; links?: unknown };
    if (!b.toMemberId) return reply.code(400).send({ error: "toMemberId required" });
    if (!(await getWorkspaceMember(b.toMemberId, task.workspaceId))) {
      return reply.code(404).send({ error: "handoff target not found in this workspace" });
    }
    // Validate every artifact link is a real message/memory in this workspace (the link IDOR guard).
    const links: HandoffLink[] = [];
    if (Array.isArray(b.links)) {
      for (const raw of b.links) {
        const l = raw as { targetType?: string; targetId?: string };
        if (!l.targetType || !l.targetId) {
          return reply.code(400).send({ error: "each link needs targetType and targetId" });
        }
        if (!LINK_TYPES.includes(l.targetType as LinkType)) {
          return reply.code(400).send({ error: "link targetType must be message | memory" });
        }
        if (!(await targetInWorkspace(l.targetType as LinkType, l.targetId, task.workspaceId))) {
          return reply.code(404).send({ error: "link target not found in this workspace" });
        }
        links.push({ targetType: l.targetType, targetId: l.targetId });
      }
    }
    const updated = await handoffTask({
      taskId: tid,
      toMemberId: b.toMemberId,
      actorMemberId: id.memberId,
      note: b.note ?? null,
      links,
    });
    // #8: the new owner is notified (best-effort; notify no-ops on self-handoff).
    if (b.toMemberId !== task.assigneeMemberId) {
      await notify(req.log, {
        workspaceId: task.workspaceId,
        recipientMemberId: b.toMemberId,
        type: "assignment",
        actorMemberId: id.memberId,
        taskId: tid,
        excerpt: task.title,
      });
    }
    return updated;
  });

  // --- dependencies / blockers (#515) ---

  // declare that this task is blocked by another task in the same workspace (rejects cycles)
  app.post("/tasks/:tid/dependencies", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid } = req.params as { tid: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    const b = req.body as { blockerTaskId?: string };
    if (!b.blockerTaskId) return reply.code(400).send({ error: "blockerTaskId required" });
    const blocker = await getTask(b.blockerTaskId);
    if (!blocker || blocker.workspaceId !== task.workspaceId) {
      return reply.code(404).send({ error: "blocker task not found in this workspace" });
    }
    const result = await addDependency({
      workspaceId: task.workspaceId,
      blockedTaskId: tid,
      blockerTaskId: b.blockerTaskId,
      createdByMemberId: id.memberId,
    });
    if (!result.ok) {
      return reply.code(409).send({ error: "dependency would create a cycle" });
    }
    return reply.code(result.created ? 201 : 200).send({ ok: true, created: result.created });
  });

  app.delete("/tasks/:tid/dependencies/:blockerId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid, blockerId } = req.params as { tid: string; blockerId: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    const removed = await removeDependency(tid, blockerId, id.memberId);
    if (!removed) return reply.code(404).send({ error: "dependency not found" });
    return { ok: true };
  });

  // both directions: what blocks this task, and what this task blocks
  app.get("/tasks/:tid/dependencies", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid } = req.params as { tid: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    const [blockers, dependents] = await Promise.all([listBlockers(tid), listDependents(tid)]);
    return { blockers, dependents };
  });

  app.get("/tasks/:tid/events", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid } = req.params as { tid: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    return listTaskEvents(tid);
  });

  // link a task to a message/memory (workspace-validated; idempotent)
  app.post("/tasks/:tid/links", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid } = req.params as { tid: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    const b = req.body as { targetType?: string; targetId?: string };
    if (!b.targetType || !b.targetId) {
      return reply.code(400).send({ error: "targetType and targetId required" });
    }
    if (!LINK_TYPES.includes(b.targetType as LinkType)) {
      return reply.code(400).send({ error: "targetType must be message | memory" });
    }
    if (!(await targetInWorkspace(b.targetType as LinkType, b.targetId, task.workspaceId))) {
      return reply.code(404).send({ error: "link target not found in this workspace" });
    }
    const { created } = await addTaskLink({
      workspaceId: task.workspaceId,
      taskId: tid,
      targetType: b.targetType,
      targetId: b.targetId,
      createdByMemberId: id.memberId,
    });
    return reply.code(created ? 201 : 200).send({ ok: true, created });
  });

  app.delete("/tasks/:tid/links/:type/:targetId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid, type, targetId } = req.params as { tid: string; type: string; targetId: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    const removed = await removeTaskLink(tid, type, targetId, id.memberId);
    if (!removed) return reply.code(404).send({ error: "link not found" });
    return { ok: true };
  });

  app.get("/tasks/:tid/links", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { tid } = req.params as { tid: string };
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    return listTaskLinks(tid);
  });

  // reverse resolution: which tasks reference this object?
  app.get("/workspaces/:wid/links/:type/:targetId/tasks", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, type, targetId } = req.params as { wid: string; type: string; targetId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return listTasksLinkingTo(wid, type, targetId);
  });

  // --- auto-routing rules (label → eligible agent) ---

  app.post("/workspaces/:wid/task-routing-rules", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = req.body as { label?: string; agentMemberId?: string };
    if (!b.label || !b.agentMemberId) {
      return reply.code(400).send({ error: "label and agentMemberId required" });
    }
    const member = await getWorkspaceMember(b.agentMemberId, wid);
    if (!member) return reply.code(404).send({ error: "agent not found in this workspace" });
    if (member.kind !== "agent") {
      return reply.code(400).send({ error: "routing target must be an agent" });
    }
    const rule = await createRoutingRule({
      workspaceId: wid,
      label: b.label,
      agentMemberId: b.agentMemberId,
      createdByMemberId: id.memberId,
    });
    return reply.code(201).send(rule);
  });

  app.get("/workspaces/:wid/task-routing-rules", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return listRoutingRules(wid);
  });

  app.delete("/workspaces/:wid/task-routing-rules/:ruleId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, ruleId } = req.params as { wid: string; ruleId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const ok = await deleteRoutingRule(ruleId, wid);
    if (!ok) return reply.code(404).send({ error: "routing rule not found" });
    return { ok: true };
  });
}
