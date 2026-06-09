import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PreviewAnnotation } from "@reload/shared";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getAgentSession, type AgentSession } from "../db/repositories/agent-sessions.js";
import type { SessionManager } from "../runtime/manager.js";
import { NoRunCommandError, type RunProcessManager } from "../run/manager.js";
import { formatAnnotationsTask } from "../run/detect.js";

export interface RunRoutesOptions {
  runManager: RunProcessManager;
  sessionManager: SessionManager;
}

/**
 * Run tab routes (#56): run a session's app for in-app preview, read its live state, stop it, and
 * deliver UI annotations back to the agent as a follow-up session (the #51 review round trip).
 *
 * Every route is gated by **channel write capability** (running a command + steering the agent are
 * both writes) and resolves the session **scoped to its channel** (`getAgentSession(id, cid)`) so it
 * is IDOR-safe. The run command itself is never request-supplied — it comes from trusted layered
 * config (#58), the same trust boundary as the #27 harness command.
 */
export async function runRoutes(app: FastifyInstance, opts: RunRoutesOptions): Promise<void> {
  const { runManager, sessionManager } = opts;

  /** Resolve identity + channel-write + the channel-scoped session, or send the error and return null. */
  async function authorize(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{
    workspaceId: string;
    memberId: string;
    cid: string;
    sessionId: string;
    session: AgentSession;
  } | null> {
    const id = await requireIdentity(req, reply);
    if (!id) return null;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "write", reply))) return null;
    const session = await getAgentSession(sessionId, cid);
    if (!session) {
      reply.code(404).send({ error: "session not found" });
      return null;
    }
    return { workspaceId: id.workspaceId, memberId: id.memberId, cid, sessionId, session };
  }

  // Start (or return the already-running) run process for a session.
  app.post("/channels/:cid/agent-sessions/:id/run", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;
    try {
      const state = await runManager.start({
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        channelId: ctx.cid,
      });
      return reply.code(202).send(state);
    } catch (err) {
      if (err instanceof NoRunCommandError) {
        return reply.code(409).send({ error: "no run command configured" });
      }
      throw err;
    }
  });

  // Current run state (status + url + bounded log tail). Write capability (it controls execution).
  app.get("/channels/:cid/agent-sessions/:id/run", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;
    return runManager.get(ctx.sessionId);
  });

  // Stop the run process. Idempotent.
  app.post("/channels/:cid/agent-sessions/:id/run/stop", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;
    const stopped = runManager.stop(ctx.sessionId);
    return { ok: true, stopped };
  });

  // Deliver preview annotations to the agent as a follow-up session (the round trip).
  app.post("/channels/:cid/agent-sessions/:id/annotations", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;

    const annotations = parseAnnotations((req.body as { annotations?: unknown })?.annotations);
    if (annotations === null) {
      return reply.code(400).send({ error: "annotations must be a non-empty array of {x,y,note}" });
    }

    const followUp = await sessionManager.launch({
      workspaceId: ctx.workspaceId,
      channelId: ctx.cid,
      agentMemberId: ctx.session.agentMemberId,
      createdByMemberId: ctx.memberId,
      task: formatAnnotationsTask(annotations),
    });
    return reply.code(202).send({ sessionId: followUp.id, count: annotations.length });
  });
}

/** Bounds on the annotation payload — it is interpolated into the follow-up agent's prompt, so an
 * unbounded note/array would be an injection of arbitrary bulk into the agent's context. */
const MAX_ANNOTATIONS = 50;
const MAX_NOTE_LEN = 2000;
const MAX_URL_LEN = 2048;

/** Validate + bound the request body into a clean annotation list, or null if malformed/empty/oversized. */
function parseAnnotations(raw: unknown): PreviewAnnotation[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ANNOTATIONS) return null;
  const out: PreviewAnnotation[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const a = item as Record<string, unknown>;
    if (!isFraction(a.x) || !isFraction(a.y)) return null;
    if (typeof a.note !== "string" || a.note.trim() === "" || a.note.length > MAX_NOTE_LEN) return null;
    const pageUrl = typeof a.pageUrl === "string" ? a.pageUrl : "";
    if (pageUrl.length > MAX_URL_LEN) return null;
    const annotation: PreviewAnnotation = { x: a.x as number, y: a.y as number, note: a.note, pageUrl };
    if (isFraction(a.width)) annotation.width = a.width as number;
    if (isFraction(a.height)) annotation.height = a.height as number;
    out.push(annotation);
  }
  return out;
}

/** A normalized viewport fraction: a finite number in [0, 1]. */
function isFraction(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}
