import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import {
  DependencySchedulerError,
  type DependencySchedulerService,
} from "../dependency-scheduler/service.js";
import type { TaskKind } from "../dependency-scheduler/types.js";

export interface DependencySchedulerRoutesOptions {
  service: DependencySchedulerService;
}

const TASK_KINDS: readonly TaskKind[] = [
  "review",
  "brand_check",
  "approval",
  "draft",
  "generate",
  "publish",
  "send",
  "post",
  "distribute",
  "task",
];

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

function schedulerError(err: unknown, reply: FastifyReply): unknown {
  if (err instanceof DependencySchedulerError) return reply.code(409).send({ error: err.message });
  throw err;
}

/**
 * #590 dependency-aware scheduler routes. The API is intentionally small and workspace-scoped:
 * declare a task graph, inspect the current plan, claim only runnable work, then advance gates/tasks.
 * The service owns the safety invariant: outbound work is never claimable until its upstream gate is approved.
 */
export async function dependencySchedulerRoutes(
  app: FastifyInstance,
  opts: DependencySchedulerRoutesOptions,
): Promise<void> {
  const { service } = opts;

  app.get("/workspaces/:wid/dependency-scheduler/policy", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.policy;
  });

  app.post("/workspaces/:wid/dependency-scheduler/tasks", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isTaskKind(body.kind)) return reply.code(400).send({ error: "valid kind required" });
    const task = await service.schedule({
      workspaceId: wid,
      kind: body.kind,
      dependsOn: readStringArray(body.dependsOn),
      objectiveId: typeof body.objectiveId === "string" ? body.objectiveId : null,
      label: typeof body.label === "string" ? body.label : null,
      priority: typeof body.priority === "number" ? body.priority : 0,
    });
    return reply.code(201).send(task);
  });

  app.get("/workspaces/:wid/dependency-scheduler/tasks", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { objectiveId?: string };
    return service.list(wid, q.objectiveId);
  });

  app.get("/workspaces/:wid/dependency-scheduler/tasks/:taskId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, taskId } = req.params as { wid: string; taskId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const task = await service.get(wid, taskId);
    return task ?? reply.code(404).send({ error: "task not found" });
  });

  app.get("/workspaces/:wid/dependency-scheduler/plan", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { objectiveId?: string };
    return service.plan(wid, q.objectiveId);
  });

  app.post("/workspaces/:wid/dependency-scheduler/claim", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as { objectiveId?: string };
    return { task: await service.claimNext(wid, body.objectiveId) };
  });

  const advance =
    (fn: "complete" | "approve" | "reject" | "fail" | "cancel") =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const id = await requireIdentity(req, reply);
      if (!id) return;
      const { wid, taskId } = req.params as { wid: string; taskId: string };
      if (!assertWorkspace(id, wid, reply)) return;
      try {
        return await service[fn](wid, taskId);
      } catch (err) {
        return schedulerError(err, reply);
      }
    };

  app.post("/workspaces/:wid/dependency-scheduler/tasks/:taskId/complete", advance("complete"));
  app.post("/workspaces/:wid/dependency-scheduler/tasks/:taskId/approve", advance("approve"));
  app.post("/workspaces/:wid/dependency-scheduler/tasks/:taskId/reject", advance("reject"));
  app.post("/workspaces/:wid/dependency-scheduler/tasks/:taskId/fail", advance("fail"));
  app.post("/workspaces/:wid/dependency-scheduler/tasks/:taskId/cancel", advance("cancel"));
}
