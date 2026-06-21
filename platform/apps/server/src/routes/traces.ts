import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireMemoryCapability } from "../auth/access.js";
import { createDefaultTraceService } from "../trace/default.js";

/**
 * Observation/replay trace read routes (issue #560) — the console-timeline + replay surface over an agent
 * run's append-only trace. Read-only on purpose: a trace is WRITTEN by the runtime/harness through the
 * service as a run executes (so secret redaction can never be bypassed at a public write door); these
 * routes only expose it. RBAC reuses the #16 memory ladder (`requireMemoryCapability` read) — a trace is
 * observability data governed like the memory graph. Every route is workspace-scoped (#3 IDOR). Payloads
 * are already redacted at the write site, so nothing here re-exposes a secret or internal chatter (#200).
 */
export async function tracesRoutes(app: FastifyInstance): Promise<void> {
  const service = createDefaultTraceService();

  // list a workspace's trace runs, newest first (the console timeline). ?sessionId= and ?limit= filter.
  app.get("/workspaces/:wid/traces", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const q = req.query as { sessionId?: string; limit?: string };
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return service.listRuns(wid, {
      sessionId: q.sessionId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  });

  // the full trace for one run: header + every event in replay (seq) order.
  app.get("/workspaces/:wid/traces/:runId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, runId } = req.params as { wid: string; runId: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const trace = await service.getTrace(wid, runId);
    if (!trace) return reply.code(404).send({ error: "trace not found in this workspace" });
    return trace;
  });

  // the replay: the run's decision path reconstructed turn-by-turn from the append-only log.
  app.get("/workspaces/:wid/traces/:runId/replay", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, runId } = req.params as { wid: string; runId: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const replay = await service.replay(wid, runId);
    if (!replay) return reply.code(404).send({ error: "trace not found in this workspace" });
    return replay;
  });
}
