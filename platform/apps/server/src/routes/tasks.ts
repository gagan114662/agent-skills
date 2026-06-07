import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { requireTaskInWorkspace } from "../auth/access.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { notify } from "../notifications/service.js";
import type { Identity } from "../auth/identity.js";
import { messageInWorkspace } from "../db/repositories/messages.js";
import { memoryInWorkspace } from "../db/repositories/memories.js";
import { canTransition, isStatus, type TaskStatus } from "../tasks/status.js";
import {
  createTask,
  listTasks,
  boardView,
  updateStatus,
  assignTask,
  listTaskEvents,
  addTaskLink,
  removeTaskLink,
  listTaskLinks,
  listTasksLinkingTo,
  createRoutingRule,
  listRoutingRules,
  deleteRoutingRule,
  pickRouteAssignee,
  type Task,
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
    return updateStatus(tid, b.status, id.memberId);
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
      return assignAndNotify(req, id, task, target);
    }
    if (!("assigneeMemberId" in b)) {
      return reply.code(400).send({ error: "provide assigneeMemberId or autoRoute" });
    }
    if (b.assigneeMemberId) {
      if (!(await getWorkspaceMember(b.assigneeMemberId, task.workspaceId))) {
        return reply.code(404).send({ error: "assignee not found in this workspace" });
      }
    }
    return assignAndNotify(req, id, task, b.assigneeMemberId ?? null);
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
