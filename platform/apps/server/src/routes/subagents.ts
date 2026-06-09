import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { effectiveChannelCapabilityFor } from "../auth/access.js";
import { generateAgentToken } from "../auth/secrets.js";
import { getChannel } from "../db/repositories/channels.js";
import { listMentionsOnMessage } from "../db/repositories/mentions.js";
import { getMessage } from "../db/repositories/messages.js";
import { deactivateAgent } from "../db/repositories/auth.js";
import {
  definePersona,
  getPersona,
  listPersonas,
  type AgentPersona,
} from "../db/repositories/personas.js";
import { personaMentionsOnMessage } from "../messaging/subagent-mentions.js";
import { seedBuiltinPersonas } from "../subagents/builtins.js";
import { PersonaValidationError, validatePersonaInput } from "../subagents/scope.js";
import {
  SubagentService,
  type SubagentInvokeResult,
} from "../subagents/service.js";
import type { SessionManager } from "../runtime/manager.js";

export interface SubagentRoutesOptions {
  sessionManager: SessionManager;
}

/** Public shape of a persona (never includes the token; that is returned once at creation). */
function toPersonaView(p: AgentPersona) {
  return {
    id: p.id,
    name: p.name,
    agentMemberId: p.agentMemberId,
    agentId: p.agentId,
    allowedTools: p.allowedTools,
    model: p.model,
    isBuiltin: p.isBuiltin,
    createdAt: p.createdAt,
  };
}

/**
 * Custom subagents / agent personas (#59, ADR-0036). Define an @-mentionable persona (a system
 * prompt + an allowed-tools ceiling), then invoke it in a channel — it runs the real harness (#50)
 * AS its own agent member via the SessionManager (#25), scoped to its tools, with its result threaded
 * back under the invoking @mention message. The {@link SubagentService} is the single security gate
 * (#9 capability ladder); these routes are thin adapters that translate its result codes to HTTP.
 */
export async function subagentRoutes(
  app: FastifyInstance,
  opts: SubagentRoutesOptions,
): Promise<void> {
  const { sessionManager } = opts;

  const service = new SubagentService({
    getPersona,
    getChannelWorkspace: async (channelId) => (await getChannel(channelId))?.workspaceId,
    channelCapabilityFor: effectiveChannelCapabilityFor,
    mentionedMemberIds: async (messageId) =>
      (await listMentionsOnMessage(messageId)).map((m) => m.memberId),
    launcher: sessionManager,
  });

  const sendInvokeResult = (reply: FastifyReply, result: SubagentInvokeResult) => {
    if (result.ok) return reply.code(202).send({ sessionId: result.sessionId });
    return reply.code(result.code).send({ error: result.error });
  };

  // Define a persona (human-auth, like agent registration). Returns the agent token ONCE.
  app.post("/workspaces/:wid/personas", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (id.kind !== "human") return reply.code(401).send({ error: "human authentication required" });
    if (id.workspaceId !== wid) return reply.code(403).send({ error: "not a member of this workspace" });

    const b = req.body as {
      name?: string;
      systemPrompt?: string;
      allowedTools?: string[];
      model?: string | null;
    };
    let v;
    try {
      v = validatePersonaInput({
        name: b.name ?? "",
        systemPrompt: b.systemPrompt ?? "",
        allowedTools: b.allowedTools ?? [],
        model: b.model ?? null,
      });
    } catch (err) {
      if (err instanceof PersonaValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const { raw, hash } = generateAgentToken();
    let persona: AgentPersona;
    try {
      persona = await definePersona(
        {
          workspaceId: wid,
          name: v.name,
          systemPrompt: v.systemPrompt,
          allowedTools: v.allowedTools,
          model: v.model,
          tokenHash: hash,
        },
        id.memberId,
      );
    } catch (err) {
      // Unique (workspace, name) violation → a handle is already taken.
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        return reply.code(409).send({ error: "a persona with that handle already exists" });
      }
      throw err;
    }
    return reply.code(201).send({ ...toPersonaView(persona), token: raw });
  });

  // List the workspace's personas (any member may read the roster).
  app.get("/workspaces/:wid/personas", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (id.workspaceId !== wid) return reply.code(403).send({ error: "not a member of this workspace" });
    return (await listPersonas(wid)).map(toPersonaView);
  });

  // Seed the built-in reference personas (e.g. code-reviewer). Idempotent, human-auth.
  app.post("/workspaces/:wid/personas/seed-builtins", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (id.kind !== "human") return reply.code(401).send({ error: "human authentication required" });
    if (id.workspaceId !== wid) return reply.code(403).send({ error: "not a member of this workspace" });
    const personas = await seedBuiltinPersonas(wid, id.memberId);
    return reply.code(201).send(personas.map(toPersonaView));
  });

  // Deactivate a persona: reuse #9 agent deactivation (blocks auth + revokes tokens; the persona
  // stops resolving as a member, so it is no longer mentionable or invokable). Human-auth.
  app.post("/workspaces/:wid/personas/:pid/deactivate", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, pid } = req.params as { wid: string; pid: string };
    if (id.kind !== "human") return reply.code(401).send({ error: "human authentication required" });
    if (id.workspaceId !== wid) return reply.code(403).send({ error: "not a member of this workspace" });
    const persona = await getPersona(pid, wid);
    if (!persona) return reply.code(404).send({ error: "persona not found in this workspace" });
    await deactivateAgent(persona.agentId, wid);
    return { ok: true };
  });

  // Invoke a persona explicitly in a channel. The SubagentService enforces all RBAC gates.
  app.post("/channels/:cid/personas/:pid/invoke", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, pid } = req.params as { cid: string; pid: string };
    const b = req.body as { task?: string; messageId?: string; tools?: string[] };
    if (!b.task) return reply.code(400).send({ error: "task required" });
    const result = await service.invoke(id, {
      personaId: pid,
      channelId: cid,
      task: b.task,
      messageId: b.messageId,
      tools: b.tools,
    });
    return sendInvokeResult(reply, result);
  });

  // @mention path: invoke every persona @-mentioned on a message. The message body is the task
  // (the diff / instruction), and each subagent's result threads back under that message.
  app.post("/channels/:cid/messages/:mid/subagents", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, mid } = req.params as { cid: string; mid: string };
    const b = (req.body ?? {}) as { task?: string; tools?: string[] };

    const message = await getMessage(mid);
    if (!message || message.channelId !== cid) {
      return reply.code(404).send({ error: "message not found in this channel" });
    }
    const personas = await personaMentionsOnMessage(id.workspaceId, mid);
    if (personas.length === 0) {
      return reply.code(400).send({ error: "no subagent personas are mentioned on this message" });
    }
    const task = b.task ?? message.body;
    const launched: Array<{ personaId: string; name: string; sessionId: string }> = [];
    for (const persona of personas) {
      const result = await service.invoke(id, {
        personaId: persona.id,
        channelId: cid,
        task,
        messageId: mid,
        tools: b.tools,
      });
      if (!result.ok) return sendInvokeResult(reply, result);
      launched.push({ personaId: persona.id, name: persona.name, sessionId: result.sessionId });
    }
    return reply.code(202).send({ launched });
  });
}
