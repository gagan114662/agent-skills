import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { addChannelMember } from "../db/repositories/channels.js";
import { grantCapability } from "../db/repositories/permissions.js";
import { getAgentSession, listAgentSessions } from "../db/repositories/agent-sessions.js";
import type { SessionManager } from "../runtime/manager.js";
import { PreflightError } from "../runtime/preflight.js";
import { isHarnessKind } from "../runtime/harness.js";
import { loadConfig } from "../config/loader.js";
import {
  modelPolicyFromConfig,
  resolveSelection,
  SelectionError,
  type ResolvedSelection,
  type SelectionInput,
} from "../runtime/model-selection.js";

export interface AgentSessionRoutesOptions {
  sessionManager: SessionManager;
}

/**
 * Cloud agent execution routes (#25). A human (or agent with write) launches an agent session
 * into a channel; the SessionManager runs it server-side on the configured AgentRuntime and
 * streams output back as the agent member — so the work continues after the client disconnects.
 *
 * Gating reuses #9 channel capabilities + the #19 tenant guard. The launch route never accepts a
 * host command from the client: the harness command is fixed by config and the caller only
 * supplies a task (data).
 */
export async function agentSessionRoutes(
  app: FastifyInstance,
  opts: AgentSessionRoutesOptions,
): Promise<void> {
  const { sessionManager } = opts;

  // Launch a session: write capability on the channel; the target must be an agent in-workspace.
  app.post("/channels/:cid/agent-sessions", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    const ch = await requireChannelCapability(id, cid, "write", reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });

    const b = req.body as {
      agentMemberId?: string;
      task?: string;
      provider?: string;
      model?: string;
      effort?: string;
      mode?: string;
      harness?: string;
    };
    if (!b.agentMemberId) return reply.code(400).send({ error: "agentMemberId required" });
    if (!b.task) return reply.code(400).send({ error: "task required" });

    // Per-session harness selection (#50): validate against the allowlist here, so an unknown kind
    // is a content-free 400 before any persistence or runtime call. Omitted → the deployment default.
    if (b.harness !== undefined && !isHarnessKind(b.harness)) {
      return reply.code(400).send({ error: "unknown harness" });
    }

    // Model/provider selection (#52). Resolve a selection only when the caller asks for one OR the
    // tenant pins a default model — otherwise leave the session on the deployment default (unchanged
    // behavior). A policy violation (disallowed provider/model, missing Auto pair, custom URL under
    // data-privacy) is a content-free 400; nothing about the selection ever logs a secret.
    let selection: ResolvedSelection | undefined;
    const wantsSelection = Boolean(b.provider || b.model || b.effort || b.mode);
    const config = loadConfig(id.workspaceId);
    if (wantsSelection || config.models.defaultModel) {
      const requested: SelectionInput = {
        provider: b.provider,
        model: b.model,
        effort: b.effort,
        mode: b.mode,
      };
      try {
        selection = resolveSelection(requested, modelPolicyFromConfig(config));
      } catch (err) {
        if (err instanceof SelectionError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    }

    // Cross-tenant + kind guard: the runner must be an agent member of THIS workspace (IDOR).
    const target = await getWorkspaceMember(b.agentMemberId, id.workspaceId);
    if (!target) return reply.code(404).send({ error: "agent not found in this workspace" });
    if (target.kind !== "agent") {
      return reply.code(400).send({ error: "agentMemberId must reference an agent member" });
    }

    // The agent posts its streamed output into this channel — make it a legitimate writer.
    await addChannelMember(cid, target.id);
    await grantCapability({
      workspaceId: id.workspaceId,
      memberId: target.id,
      resourceType: "channel",
      resourceId: cid,
      capability: "write",
      grantedByMemberId: id.memberId,
    });

    let session;
    try {
      session = await sessionManager.launch({
        workspaceId: id.workspaceId,
        channelId: cid,
        agentMemberId: target.id,
        createdByMemberId: id.memberId,
        task: b.task,
        // #50: the validated per-session harness override (undefined → deployment default). Already
        // checked against the allowlist above; the SessionManager defensively re-validates.
        harness: isHarnessKind(b.harness) ? b.harness : undefined,
        // #52: the secret-free selection env (provider flags, model, thinking budget) rides the same
        // injection-safe seam as the task/persona; the metadata is persisted on the row for audit.
        harnessEnv: selection?.env,
        selection: selection
          ? {
              provider: selection.provider,
              model: selection.model,
              effort: selection.effort,
              mode: selection.mode,
            }
          : undefined,
      });
    } catch (err) {
      // #69: a misconfigured cloud/real-agent posture is caught by preflight BEFORE any cloud call
      // or persisted row — surface it as a 412 with the actionable, secret-free report (names only).
      if (err instanceof PreflightError) {
        return reply.code(412).send({ error: err.message, preflight: err.report });
      }
      throw err;
    }
    // 202: accepted and running server-side; the client can disconnect now.
    return reply.code(202).send({
      id: session.id,
      status: session.status,
      runtime: session.runtime,
      harness: session.harness,
      agentMemberId: session.agentMemberId,
      provider: session.provider,
      model: session.model,
      effort: session.effort,
      mode: session.mode,
    });
  });

  // List a channel's agent sessions (read capability).
  app.get("/channels/:cid/agent-sessions", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    return listAgentSessions(cid);
  });

  // Get one session's status (read capability; scoped to the channel → tenant-safe).
  app.get("/channels/:cid/agent-sessions/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    const session = await getAgentSession(sessionId, cid);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return session;
  });

  // Cancel a running session (write capability). Idempotent.
  app.post("/channels/:cid/agent-sessions/:id/cancel", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "write", reply))) return;
    // Confirm the session belongs to this channel before touching the in-memory runner (IDOR).
    const session = await getAgentSession(sessionId, cid);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const canceled = await sessionManager.cancel(sessionId);
    return { ok: true, canceled };
  });
}
