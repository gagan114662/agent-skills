import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { requireChannelCapability, requireTaskInWorkspace } from "../auth/access.js";
import type { Identity } from "../auth/identity.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { addChannelMember } from "../db/repositories/channels.js";
import { grantCapability } from "../db/repositories/permissions.js";
import { assignTask } from "../db/repositories/tasks.js";
import {
  createPool,
  listPools,
  getPool,
  addPoolMember,
  listPoolMembers,
  agentRoles,
  isAgentPooled,
  upsertAutonomy,
  getControls,
  setKillSwitch,
  createWorkflow,
  getWorkflow,
  listWorkflowsInChannel,
  listApprovals,
  type WorkflowStage,
} from "../db/repositories/autonomy.js";
import type { AutonomyEngine } from "../autonomy/engine.js";

export interface AutonomyRoutesOptions {
  engine: AutonomyEngine;
}

/** Resolve a human caller in `workspaceId`, or send the error and return undefined. */
async function requireHumanInWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string,
): Promise<Identity | undefined> {
  const id = await requireIdentity(req, reply);
  if (!id) return undefined;
  if (id.kind !== "human") {
    await reply.code(403).send({ error: "human authentication required" });
    return undefined;
  }
  if (!assertWorkspace(id, workspaceId, reply)) return undefined;
  return id;
}

/**
 * Cross-team agent pooling + autonomy routes (#17, ADR-0017). Pools + autonomy config + the kill
 * switch are human-administered and workspace-scoped; workflows are created against a channel
 * (the "team") under #9 write capability; approvals are the human gate (agents can't self-approve).
 * Every route carries the #19 tenant guard / #3 IDOR discipline.
 */
export async function autonomyRoutes(
  app: FastifyInstance,
  opts: AutonomyRoutesOptions,
): Promise<void> {
  const { engine } = opts;

  // ---- pools ---------------------------------------------------------------

  // Create a pool (human, workspace-scoped).
  app.post("/workspaces/:workspaceId/agent-pools", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const id = await requireHumanInWorkspace(req, reply, workspaceId);
    if (!id) return;
    const b = req.body as { name?: string; description?: string };
    if (!b.name) return reply.code(400).send({ error: "name required" });
    const pool = await createPool({
      workspaceId,
      name: b.name,
      description: b.description,
      createdByMemberId: id.memberId,
    });
    return reply.code(201).send(pool);
  });

  // List pools + their members (any workspace member).
  app.get("/workspaces/:workspaceId/agent-pools", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const id = await requireIdentity(req, reply);
    if (!id) return;
    if (!assertWorkspace(id, workspaceId, reply)) return;
    const pools = await listPools(workspaceId);
    return Promise.all(
      pools.map(async (p) => ({ ...p, members: await listPoolMembers(p.id) })),
    );
  });

  // Add an agent to a pool with its roles (human). Idempotent — updates roles if already a member.
  app.post("/workspaces/:workspaceId/agent-pools/:poolId/agents", async (req, reply) => {
    const { workspaceId, poolId } = req.params as { workspaceId: string; poolId: string };
    const id = await requireHumanInWorkspace(req, reply, workspaceId);
    if (!id) return;
    const b = req.body as { agentMemberId?: string; roles?: string[] };
    if (!b.agentMemberId) return reply.code(400).send({ error: "agentMemberId required" });
    const pool = await getPool(poolId, workspaceId);
    if (!pool) return reply.code(404).send({ error: "pool not found in this workspace" });
    const member = await getWorkspaceMember(b.agentMemberId, workspaceId);
    if (!member) return reply.code(404).send({ error: "agent not found in this workspace" });
    if (member.kind !== "agent") {
      return reply.code(400).send({ error: "agentMemberId must reference an agent member" });
    }
    const added = await addPoolMember({
      workspaceId,
      poolId,
      agentMemberId: b.agentMemberId,
      roles: b.roles ?? [],
    });
    return reply.code(201).send(added);
  });

  // Share a pooled agent into a channel ("team"): grant membership + #9 write capability there.
  app.post("/channels/:cid/share-agent", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    const ch = await requireChannelCapability(id, cid, "write", reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });
    const b = req.body as { agentMemberId?: string };
    if (!b.agentMemberId) return reply.code(400).send({ error: "agentMemberId required" });
    const member = await getWorkspaceMember(b.agentMemberId, id.workspaceId);
    if (!member || member.kind !== "agent") {
      return reply.code(404).send({ error: "agent not found in this workspace" });
    }
    if (!(await isAgentPooled(id.workspaceId, b.agentMemberId))) {
      return reply.code(400).send({ error: "agent is not in a pool (not shareable)" });
    }
    await addChannelMember(cid, b.agentMemberId);
    await grantCapability({
      workspaceId: id.workspaceId,
      memberId: b.agentMemberId,
      resourceType: "channel",
      resourceId: cid,
      capability: "write",
      grantedByMemberId: id.memberId,
    });
    const roles = await agentRoles(id.workspaceId, b.agentMemberId);
    return reply.code(201).send({ ok: true, agentMemberId: b.agentMemberId, channelId: cid, roles });
  });

  // ---- autonomy config (per agent) ----------------------------------------

  app.put("/workspaces/:workspaceId/agents/:memberId/autonomy", async (req, reply) => {
    const { workspaceId, memberId } = req.params as { workspaceId: string; memberId: string };
    const id = await requireHumanInWorkspace(req, reply, workspaceId);
    if (!id) return;
    const member = await getWorkspaceMember(memberId, workspaceId);
    if (!member || member.kind !== "agent") {
      return reply.code(404).send({ error: "agent not found in this workspace" });
    }
    const b = req.body as {
      enabled?: boolean;
      maxActionsPerTick?: number;
      actionBudget?: number;
    };
    const config = await upsertAutonomy({
      workspaceId,
      agentMemberId: memberId,
      enabled: b.enabled ?? false,
      maxActionsPerTick: b.maxActionsPerTick ?? 5,
      actionBudget: b.actionBudget ?? 100,
    });
    return config;
  });

  // ---- controls: kill switch + status + manual tick -----------------------

  app.get("/workspaces/:workspaceId/autonomy", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const id = await requireIdentity(req, reply);
    if (!id) return;
    if (!assertWorkspace(id, workspaceId, reply)) return;
    const controls = await getControls(workspaceId);
    const pending = await listApprovals(workspaceId, { status: "pending" });
    return { killSwitch: controls.killSwitch, pendingApprovals: pending.length };
  });

  app.post("/workspaces/:workspaceId/autonomy/kill", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const id = await requireHumanInWorkspace(req, reply, workspaceId);
    if (!id) return;
    const controls = await setKillSwitch(workspaceId, true, id.memberId);
    return { ok: true, killSwitch: controls.killSwitch };
  });

  app.post("/workspaces/:workspaceId/autonomy/resume", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const id = await requireHumanInWorkspace(req, reply, workspaceId);
    if (!id) return;
    const controls = await setKillSwitch(workspaceId, false, id.memberId);
    return { ok: true, killSwitch: controls.killSwitch };
  });

  // Manually drive one autonomy pass (ops / demo). Human-only.
  app.post("/workspaces/:workspaceId/autonomy/tick", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const id = await requireHumanInWorkspace(req, reply, workspaceId);
    if (!id) return;
    return engine.tick(workspaceId);
  });

  // ---- workflows -----------------------------------------------------------

  // Create a workflow over a task in this channel. Each stage's agent must be an agent member of
  // the workspace and must fill the stage's role (per its pool roles); it is shared into the
  // channel so it can act + narrate there. The task is assigned to the first stage's agent.
  app.post("/channels/:cid/workflows", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    const ch = await requireChannelCapability(id, cid, "write", reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });

    const b = req.body as { taskId?: string; stages?: WorkflowStage[] };
    if (!b.taskId) return reply.code(400).send({ error: "taskId required" });
    if (!b.stages || b.stages.length === 0) {
      return reply.code(400).send({ error: "at least one stage required" });
    }
    const task = await requireTaskInWorkspace(id, b.taskId, reply);
    if (!task) return;

    // Validate every stage agent + role, then share each into the channel so it may act there.
    for (const stage of b.stages) {
      if (!stage.agentMemberId || !stage.role) {
        return reply.code(400).send({ error: "each stage needs agentMemberId and role" });
      }
      const member = await getWorkspaceMember(stage.agentMemberId, id.workspaceId);
      if (!member || member.kind !== "agent") {
        return reply.code(404).send({ error: `agent ${stage.agentMemberId} not found` });
      }
      const roles = await agentRoles(id.workspaceId, stage.agentMemberId);
      if (!roles.includes(stage.role)) {
        return reply
          .code(400)
          .send({ error: `agent ${stage.agentMemberId} does not fill role "${stage.role}"` });
      }
    }
    for (const stage of b.stages) {
      await addChannelMember(cid, stage.agentMemberId);
      await grantCapability({
        workspaceId: id.workspaceId,
        memberId: stage.agentMemberId,
        resourceType: "channel",
        resourceId: cid,
        capability: "write",
        grantedByMemberId: id.memberId,
      });
    }

    // Assign the task to the first stage's agent so the loop can progress its own work (AC1).
    await assignTask(b.taskId, b.stages[0]!.agentMemberId, id.memberId);
    const workflow = await createWorkflow({
      workspaceId: id.workspaceId,
      channelId: cid,
      taskId: b.taskId,
      stages: b.stages,
      createdByMemberId: id.memberId,
    });
    return reply.code(201).send(workflow);
  });

  app.get("/channels/:cid/workflows", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    return listWorkflowsInChannel(cid);
  });

  app.get("/channels/:cid/workflows/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: workflowId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    const wf = await getWorkflow(workflowId, id.workspaceId);
    if (!wf || wf.channelId !== cid) return reply.code(404).send({ error: "workflow not found" });
    return wf;
  });

  // ---- approvals (the human gate) -----------------------------------------

  app.get("/workspaces/:workspaceId/approvals", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const id = await requireIdentity(req, reply);
    if (!id) return;
    if (!assertWorkspace(id, workspaceId, reply)) return;
    const q = req.query as { status?: "pending" | "approved" | "rejected" };
    return listApprovals(workspaceId, { status: q.status });
  });

  app.post("/workspaces/:workspaceId/approvals/:id/approve", async (req, reply) => {
    const { workspaceId, id: approvalId } = req.params as { workspaceId: string; id: string };
    const id = await requireHumanInWorkspace(req, reply, workspaceId);
    if (!id) return;
    const result = await engine.approve(workspaceId, approvalId, id.memberId);
    if (!result.ok) {
      return reply.code(result.reason === "not_found" ? 404 : 409).send({ error: result.reason });
    }
    return { ok: true };
  });

  app.post("/workspaces/:workspaceId/approvals/:id/reject", async (req, reply) => {
    const { workspaceId, id: approvalId } = req.params as { workspaceId: string; id: string };
    const id = await requireHumanInWorkspace(req, reply, workspaceId);
    if (!id) return;
    const result = await engine.reject(workspaceId, approvalId, id.memberId);
    if (!result.ok) {
      return reply.code(result.reason === "not_found" ? 404 : 409).send({ error: result.reason });
    }
    return { ok: true };
  });
}
