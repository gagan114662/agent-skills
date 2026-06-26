import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { addChannelMember } from "../db/repositories/channels.js";
import { grantCapability } from "../db/repositories/permissions.js";
import {
  getAgentSession,
  listAgentSessions,
  type AgentSession,
} from "../db/repositories/agent-sessions.js";
import type { SessionManager } from "../runtime/manager.js";
import { PreflightError } from "../runtime/preflight.js";
import { isHarnessKind } from "../runtime/harness.js";
import { classifyFailure, failureCopy, isSuccess, type FailureReasonClass } from "../runtime/outcome.js";
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

/** The classified, human-readable cause of a failed run, surfaced to the UI so a failure is never silent (#634). */
export interface SessionFailure {
  failureClass: FailureReasonClass;
  /** One-line, brand-voice "what happened". */
  headline: string;
  /** One-line "what to do next" (retry / reconnect / pick a model …). */
  detail: string;
}

function quotaResetHint(result: string | null | undefined): string | null {
  if (!result) return null;
  const match = /\bresets?\s+([^\n\r.;]+)/i.exec(result);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  const safe = raw.replace(/[^A-Za-z0-9 ,:()/-]/g, "").trim().slice(0, 80);
  return safe.length > 0 ? safe : null;
}

/**
 * Derive the failure cause for a run from its terminal signals (#634). Returns null for a live
 * (`provisioning`/`running`) or cleanly-`completed` run — only a terminal NON-completed status is a
 * failure. The redacted `result` tail is used ONLY to refine the class (auth/model/overload markers) and
 * is never echoed back: the returned object carries only the class + brand-voice copy, no raw output.
 */
export function sessionFailure(
  session: Pick<AgentSession, "status" | "exitCode" | "result">,
): SessionFailure | null {
  if (session.status === "provisioning" || session.status === "running" || isSuccess(session.status)) {
    return null;
  }
  const failureClass = classifyFailure({
    status: session.status,
    exitCode: session.exitCode,
    outputTail: session.result ?? undefined,
  });
  const copy = failureCopy(failureClass);
  const resetHint = failureClass === "quota" ? quotaResetHint(session.result) : null;
  const detail = resetHint ? `${copy.detail} Reset: ${resetHint}.` : copy.detail;
  return { failureClass, headline: copy.headline, detail };
}

/** A session row plus its derived (never-silent) failure cause — the shape the run-status UI reads. */
type SessionWithFailure = AgentSession & { failure: SessionFailure | null };

function withFailure(session: AgentSession): SessionWithFailure {
  return { ...session, failure: sessionFailure(session) };
}

/**
 * Resolve a per-session model/provider selection (#52) against the tenant policy, shared by launch and
 * retry (#634) so both validate identically. Returns `undefined` (deployment default) when the caller
 * asks for no selection AND the tenant pins no default model. Throws {@link SelectionError} on a policy
 * violation; the caller maps it to a content-free 400.
 */
function resolveSessionSelection(
  workspaceId: string,
  requested: SelectionInput,
): ResolvedSelection | undefined {
  const config = loadConfig(workspaceId);
  const wantsSelection = Boolean(
    requested.provider || requested.model || requested.effort || requested.mode,
  );
  if (!wantsSelection && !config.models.defaultModel) return undefined;
  return resolveSelection(requested, modelPolicyFromConfig(config));
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
    try {
      selection = resolveSessionSelection(id.workspaceId, {
        provider: b.provider,
        model: b.model,
        effort: b.effort,
        mode: b.mode,
      });
    } catch (err) {
      if (err instanceof SelectionError) {
        return reply.code(err.receipt ? 409 : 400).send({
          error: err.message,
          ...(err.receipt ? { receipt: err.receipt } : {}),
        });
      }
      throw err;
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

  // List a channel's agent sessions (read capability). Each row carries its derived failure cause (#634)
  // so the run-status UI can show WHY a failed run stopped — failures are never silent.
  app.get("/channels/:cid/agent-sessions", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    const sessions = await listAgentSessions(cid);
    return sessions.map(withFailure);
  });

  // Get one session's status (read capability; scoped to the channel → tenant-safe). Includes the
  // derived, human-readable failure cause (#634) on a failed run.
  app.get("/channels/:cid/agent-sessions/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    const session = await getAgentSession(sessionId, cid);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return withFailure(session);
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

  // Retry a FAILED run (#634): re-launch the same agent with the same model selection on a re-briefed
  // task. Write capability on the channel. The original task is never persisted on the row (it rides as
  // injected env / a channel message, never stored), so a faithful retry re-supplies it in the body —
  // the agent, harness, and model/provider selection are reused from the failed row.
  app.post("/channels/:cid/agent-sessions/:id/retry", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    const ch = await requireChannelCapability(id, cid, "write", reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });

    // Confirm the run belongs to this channel before anything else (IDOR / tenant safety).
    const prior = await getAgentSession(sessionId, cid);
    if (!prior) return reply.code(404).send({ error: "session not found" });

    // Only a FAILED run can be retried — a live or cleanly-completed run has nothing to retry.
    if (!sessionFailure(prior)) {
      return reply.code(409).send({ error: "only a failed run can be retried" });
    }

    const b = req.body as { task?: string };
    if (!b.task) return reply.code(400).send({ error: "task required" });

    // The target agent must still be an agent member of THIS workspace (it was at first launch; guard
    // against a since-removed/kind-changed member — same cross-tenant + kind guard as launch).
    const target = await getWorkspaceMember(prior.agentMemberId, id.workspaceId);
    if (!target) return reply.code(404).send({ error: "agent not found in this workspace" });
    if (target.kind !== "agent") {
      return reply.code(400).send({ error: "agentMemberId must reference an agent member" });
    }

    // Re-resolve the failed run's stored selection against current policy (it may have changed since the
    // first launch). A now-disallowed selection is a content-free 400.
    let selection: ResolvedSelection | undefined;
    try {
      selection = resolveSessionSelection(id.workspaceId, {
        provider: prior.provider ?? undefined,
        model: prior.model ?? undefined,
        effort: prior.effort ?? undefined,
        mode: prior.mode ?? undefined,
      });
    } catch (err) {
      if (err instanceof SelectionError) {
        return reply.code(err.receipt ? 409 : 400).send({
          error: err.message,
          ...(err.receipt ? { receipt: err.receipt } : {}),
        });
      }
      throw err;
    }

    // Keep the agent a legitimate writer (idempotent — it was granted at first launch, re-assert in case).
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
        agentMemberId: prior.agentMemberId,
        createdByMemberId: id.memberId,
        task: b.task,
        harness: isHarnessKind(prior.harness) ? prior.harness : undefined,
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
      if (err instanceof PreflightError) {
        return reply.code(412).send({ error: err.message, preflight: err.report });
      }
      throw err;
    }
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
      retriedFrom: sessionId,
    });
  });
}
