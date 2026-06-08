import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { addChannelMember } from "../db/repositories/channels.js";
import { grantCapability } from "../db/repositories/permissions.js";
import { newId } from "../db/id.js";
import type { TeamCoordinator, Subtask } from "../team/coordinator.js";

export interface TeamRoutesOptions {
  coordinator: TeamCoordinator;
}

interface SubtaskBody {
  agentMemberId?: string;
  task?: string;
  branch?: string;
}

/**
 * Team Mode routes — launch N agents in parallel on one feature, each on its own subtask/branch,
 * coordinating over the channel's shared team protocol.
 *
 * Gating reuses #9 channel capabilities + the #19 tenant guard, exactly like #25 agent-sessions:
 * a `write` capability launches; each subtask's agent must be an agent member of THIS workspace
 * (IDOR), and is granted channel membership + write so its streamed output and team events land in
 * the channel. The caller supplies only tasks (data) and branch labels — never a host command.
 */
export async function teamRoutes(app: FastifyInstance, opts: TeamRoutesOptions): Promise<void> {
  const { coordinator } = opts;

  // Launch a team run: write capability; every subtask targets an agent member in-workspace.
  app.post("/channels/:cid/team-runs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    const ch = await requireChannelCapability(id, cid, "write", reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });

    const body = req.body as { subtasks?: SubtaskBody[] };
    if (!Array.isArray(body.subtasks) || body.subtasks.length === 0) {
      return reply.code(400).send({ error: "subtasks required (non-empty array)" });
    }

    // Validate every subtask up front (all-or-nothing) before mutating any membership.
    const subtasks: Subtask[] = [];
    for (const s of body.subtasks) {
      if (!s.agentMemberId) return reply.code(400).send({ error: "subtask.agentMemberId required" });
      if (!s.task) return reply.code(400).send({ error: "subtask.task required" });
      if (!s.branch) return reply.code(400).send({ error: "subtask.branch required" });
      const target = await getWorkspaceMember(s.agentMemberId, id.workspaceId);
      if (!target) return reply.code(404).send({ error: "agent not found in this workspace" });
      if (target.kind !== "agent") {
        return reply.code(400).send({ error: "subtask.agentMemberId must reference an agent member" });
      }
      subtasks.push({
        subtaskId: newId(),
        agentMemberId: target.id,
        task: s.task,
        branch: s.branch,
      });
    }

    // Make each agent a legitimate writer in the channel (output + team events land here).
    for (const s of subtasks) {
      await addChannelMember(cid, s.agentMemberId);
      await grantCapability({
        workspaceId: id.workspaceId,
        memberId: s.agentMemberId,
        resourceType: "channel",
        resourceId: cid,
        capability: "write",
        grantedByMemberId: id.memberId,
      });
    }

    const teamRunId = newId();
    // Fire-and-forget: the run continues server-side (like a single agent session). runTeam never
    // rejects — failures are isolated per subtask — but guard the promise just in case.
    void coordinator
      .runTeam({
        workspaceId: id.workspaceId,
        channelId: cid,
        createdByMemberId: id.memberId,
        teamRunId,
        subtasks,
      })
      .catch((err) => {
        app.log.error({ err, teamRunId }, "team run crashed");
      });

    // 202: accepted and running server-side; the client can disconnect now.
    return reply.code(202).send({
      teamRunId,
      subtaskCount: subtasks.length,
      subtasks: subtasks.map((s) => ({
        subtaskId: s.subtaskId,
        agentMemberId: s.agentMemberId,
        branch: s.branch,
      })),
    });
  });

  // Read the channel's recent team events (read capability). Optional `?limit=N`.
  app.get("/channels/:cid/team-events", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    const { limit } = req.query as { limit?: string };
    const n = limit ? Number(limit) : undefined;
    const opts = n && Number.isFinite(n) && n > 0 ? { limit: n } : undefined;
    return coordinator.readEvents(cid, opts);
  });
}
