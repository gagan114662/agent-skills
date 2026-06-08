import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { listAgents, getAgentMemberByHandle } from "../db/repositories/auth.js";
import { postMessage, getMessage, listThreadReplies } from "../db/repositories/messages.js";
import { resolveAndPersistMentions, listMentionsOnMessage } from "../db/repositories/mentions.js";
import { publishMessageEvent } from "../realtime/bus.js";
import {
  toAcpAgent,
  acpMessage,
  acpPartsToText,
  deriveRunStatus,
  toAcpRun,
} from "../protocols/acp/map.js";
import type { AcpMessage, AcpRun } from "../protocols/acp/types.js";

/**
 * #12 — the ACP (Agent Communication Protocol) adapter. ACP is run-centric REST; we map a **run to
 * a Reload thread** (#6): the run's input/output are channel messages, the run's id is the
 * thread-root message id, the run's target agent is the agent @mentioned on the root, and the run's
 * output is that agent's in-thread replies. This is the literal "ACP messages map to
 * channels/threads" mapping — pure composition over #4/#6, no new table, no new authority. Every
 * call is workspace-scoped (#3 IDOR) and capability-gated (#9: posting needs `write`).
 */

/** Load the ACP run view for a thread root (the root message id IS the run id / session id). */
async function loadRun(rootId: string): Promise<AcpRun | null> {
  const root = await getMessage(rootId);
  if (!root || root.parentMessageId) return null; // not a thread root → not a run
  const mentions = await listMentionsOnMessage(rootId);
  const target = mentions.find((m) => m.kind === "agent");
  const replies = await listThreadReplies(rootId);
  const output = target
    ? replies
        .filter((r) => r.authorMemberId === target.memberId)
        .map((r) => acpMessage("agent", r.body))
    : [];
  return toAcpRun({
    run_id: rootId,
    agent_name: target?.displayName ?? "unknown",
    session_id: rootId,
    status: deriveRunStatus({ hasAgentReply: output.length > 0 }),
    output,
  });
}

export async function acpRoutes(app: FastifyInstance): Promise<void> {
  // Discovery: the workspace's agent roster as ACP manifests.
  app.get("/acp/agents", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const agents = await listAgents(identity.workspaceId);
    return agents.map(toAcpAgent);
  });

  app.get("/acp/agents/:name", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { name } = req.params as { name: string };
    const agents = await listAgents(identity.workspaceId);
    const match = agents.find((a) => a.name.toLowerCase() === name.toLowerCase() && !a.deactivatedAt);
    if (!match) return reply.code(404).send({ error: "agent not found" });
    return toAcpAgent(match);
  });

  // Create a run: post the input messages into a channel thread targeting `agent_name`.
  // A new run posts the first message as a thread root (@mentioning the agent so it is actionable,
  // #6) and the rest as replies; a `session_id` continues that thread (all messages become replies).
  app.post("/acp/runs", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const b = req.body as {
      agent_name?: string;
      input?: AcpMessage[];
      session_id?: string;
      metadata?: { channel_id?: string };
    };
    if (!b.agent_name) return reply.code(400).send({ error: "agent_name required" });
    if (!Array.isArray(b.input) || b.input.length === 0) {
      return reply.code(400).send({ error: "input must be a non-empty Message array" });
    }
    const agent = await getAgentMemberByHandle(identity.workspaceId, b.agent_name);
    if (!agent) return reply.code(404).send({ error: "agent not found in this workspace" });

    // Resolve the target channel + (for continuation) the existing thread root.
    let channelId: string;
    let rootId: string | undefined;
    if (b.session_id) {
      const root = await getMessage(b.session_id);
      if (!root || root.parentMessageId) return reply.code(404).send({ error: "session not found" });
      const ch = await requireChannelCapability(identity, root.channelId, "write", reply);
      if (!ch) return;
      if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });
      channelId = root.channelId;
      rootId = root.id;
    } else {
      channelId = b.metadata?.channel_id ?? "";
      if (!channelId) return reply.code(400).send({ error: "metadata.channel_id required for a new run" });
      const ch = await requireChannelCapability(identity, channelId, "write", reply);
      if (!ch) return;
      if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });
    }

    // Post each input message; the first message of a brand-new run becomes the thread root.
    for (const input of b.input) {
      const text = acpPartsToText(input.parts);
      const isRoot = rootId === undefined;
      const posted = await postMessage({
        workspaceId: identity.workspaceId,
        channelId,
        authorMemberId: identity.memberId,
        body: isRoot ? `@${agent.name} ${text}` : text,
        parentMessageId: isRoot ? undefined : rootId,
      });
      if (isRoot) rootId = posted.id;
      publishMessageEvent(channelId, posted).catch((err) =>
        req.log.error({ err }, "acp realtime publish failed"),
      );
      // Persist mentions (the root's @agent_name is how a run's target is later resolved).
      await resolveAndPersistMentions({
        workspaceId: identity.workspaceId,
        channelId,
        messageId: posted.id,
        authorMemberId: identity.memberId,
        body: posted.body,
      });
    }

    const run = await loadRun(rootId!);
    if (!run) return reply.code(500).send({ error: "failed to materialize run" });
    return reply.code(201).send(run);
  });

  // Read a run = read its thread. Workspace-scoped via the channel's `read` gate (#3 IDOR / #9).
  app.get("/acp/runs/:run_id", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { run_id } = req.params as { run_id: string };
    const root = await getMessage(run_id);
    if (!root || root.parentMessageId) return reply.code(404).send({ error: "run not found" });
    // The channel gate rejects a cross-workspace run id with 404 (existence never leaks).
    const ch = await requireChannelCapability(identity, root.channelId, "read", reply);
    if (!ch) return;
    const run = await loadRun(run_id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });

  // Cancel: best-effort, non-destructive. A thread is durable conversation, so cancel reports the
  // run as cancelled without deleting messages (signals an ACP client the run is done).
  app.post("/acp/runs/:run_id/cancel", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { run_id } = req.params as { run_id: string };
    const root = await getMessage(run_id);
    if (!root || root.parentMessageId) return reply.code(404).send({ error: "run not found" });
    const ch = await requireChannelCapability(identity, root.channelId, "read", reply);
    if (!ch) return;
    const mentions = await listMentionsOnMessage(run_id);
    const target = mentions.find((m) => m.kind === "agent");
    return toAcpRun({
      run_id,
      agent_name: target?.displayName ?? "unknown",
      session_id: run_id,
      status: "cancelled",
      output: [],
    });
  });
}
