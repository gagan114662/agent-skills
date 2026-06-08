import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { getAgentById, getAgentMember } from "../db/repositories/auth.js";
import { createTask, getTask, updateStatus } from "../db/repositories/tasks.js";
import { canTransition } from "../tasks/status.js";
import { newId } from "../db/id.js";
import { buildAgentCard, toA2ATask, a2aMessage, partsToText } from "../protocols/a2a/map.js";
import {
  JSONRPC_ERRORS,
  type A2AMessage,
  type JsonRpcError,
  type JsonRpcSuccess,
} from "../protocols/a2a/types.js";

/**
 * #12 — the A2A (Agent2Agent) adapter. Two things, both pure composition over the existing model
 * (no new table, no new authority):
 *
 *   1. `GET /a2a/agents/:agentId/agent-card.json` — the **capability handshake**. The AgentCard is
 *      derived from the `agents` registry (#3) + this server's URL + the #9 auth posture, telling a
 *      caller how to authenticate and what the agent accepts before it sends.
 *   2. `POST /a2a/agents/:agentId` — a JSON-RPC 2.0 endpoint for **handoff**. `message/send` creates
 *      a #14 task assigned to the receiving agent with the message content preserved as its context,
 *      so the receiver's `tasks/get` returns the task *and the original content intact*.
 *
 * Every call is workspace-scoped (#3 IDOR) and uses the same identity helper the native routes
 * trust (#11): an agent/task id from another workspace is never reachable.
 */

const ok = (id: JsonRpcSuccess["id"], result: unknown): JsonRpcSuccess => ({
  jsonrpc: "2.0",
  id,
  result,
});
const fail = (id: JsonRpcError["id"], code: number, message: string): JsonRpcError => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export async function a2aRoutes(app: FastifyInstance): Promise<void> {
  // The AgentCard for a registered agent — the A2A capability handshake. Workspace-scoped: a card
  // for another workspace's agent is a 404 (no cross-tenant discovery).
  app.get("/a2a/agents/:agentId/agent-card.json", async (req, reply: FastifyReply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { agentId } = req.params as { agentId: string };
    const agent = await getAgentById(agentId, identity.workspaceId);
    if (!agent || agent.deactivatedAt) {
      return reply.code(404).send({ error: "agent not found" });
    }
    const baseUrl = `${req.protocol}://${req.headers.host ?? "localhost:3000"}`;
    return buildAgentCard({ name: agent.name, framework: agent.framework }, { baseUrl, agentId });
  });

  // JSON-RPC 2.0 transport. The authenticated identity is the *sending* agent; `:agentId` is the
  // *receiving* agent. Auth failure is HTTP 401 (pre-RPC); every resolved request returns HTTP 200
  // with a JSON-RPC success/error envelope, per the A2A spec.
  app.post("/a2a/agents/:agentId", async (req, reply: FastifyReply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { agentId } = req.params as { agentId: string };
    const body = req.body as { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
    const rpcId = body?.id ?? null;

    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return fail(rpcId, JSONRPC_ERRORS.INVALID_REQUEST, "invalid JSON-RPC 2.0 request");
    }

    switch (body.method) {
      case "message/send": {
        const params = body.params as { message?: A2AMessage } | undefined;
        const message = params?.message;
        if (!message || !Array.isArray(message.parts)) {
          return fail(rpcId, JSONRPC_ERRORS.INVALID_PARAMS, "params.message with parts is required");
        }
        // Resolve the receiving agent (active agent member in the caller's workspace).
        const receiver = await getAgentMember(agentId, identity.workspaceId);
        if (!receiver) {
          return fail(rpcId, JSONRPC_ERRORS.INVALID_PARAMS, "receiving agent not found in this workspace");
        }
        const text = partsToText(message.parts);
        const title = (text.split("\n")[0] || "A2A handoff").slice(0, 120);
        // The handoff: a task assigned to the receiver, the message content preserved as context.
        const task = await createTask({
          workspaceId: identity.workspaceId,
          title,
          description: text,
          labels: ["a2a"],
          createdByMemberId: identity.memberId,
          assigneeMemberId: receiver.id,
        });
        const history = [
          a2aMessage({
            messageId: message.messageId || newId(),
            role: "user",
            text,
            taskId: task.id,
            contextId: task.id,
          }),
        ];
        return ok(rpcId, toA2ATask({ id: task.id, status: task.status, history }));
      }

      case "tasks/get": {
        const params = body.params as { id?: string } | undefined;
        if (!params?.id) {
          return fail(rpcId, JSONRPC_ERRORS.INVALID_PARAMS, "params.id is required");
        }
        const task = await getTask(params.id);
        if (!task || task.workspaceId !== identity.workspaceId) {
          return fail(rpcId, JSONRPC_ERRORS.TASK_NOT_FOUND, "task not found");
        }
        // Reconstruct the preserved handoff context as A2A history (content intact).
        const history = task.description
          ? [
              a2aMessage({
                messageId: `${task.id}:0`,
                role: "user",
                text: task.description,
                taskId: task.id,
                contextId: task.id,
              }),
            ]
          : [];
        return ok(rpcId, toA2ATask({ id: task.id, status: task.status, history }));
      }

      case "tasks/cancel": {
        const params = body.params as { id?: string } | undefined;
        if (!params?.id) {
          return fail(rpcId, JSONRPC_ERRORS.INVALID_PARAMS, "params.id is required");
        }
        const task = await getTask(params.id);
        if (!task || task.workspaceId !== identity.workspaceId) {
          return fail(rpcId, JSONRPC_ERRORS.TASK_NOT_FOUND, "task not found");
        }
        if (!canTransition(task.status, "canceled")) {
          return fail(rpcId, JSONRPC_ERRORS.INVALID_REQUEST, `cannot cancel a ${task.status} task`);
        }
        const updated = await updateStatus(task.id, "canceled", identity.memberId);
        return ok(rpcId, toA2ATask({ id: updated.id, status: updated.status }));
      }

      default:
        return fail(rpcId, JSONRPC_ERRORS.METHOD_NOT_FOUND, `unknown method: ${body.method}`);
    }
  });
}
