import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { VentureMemoryService } from "../venture-memory/service.js";
import { isVentureMemoryKind, type KeyResult } from "../venture-memory/types.js";

/** Coerce a request body's key results into the typed {@link KeyResult}[] (missing fields → safe defaults). */
function readKeyResults(raw: unknown): KeyResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const k = (r ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
    return {
      metric: typeof k.metric === "string" ? k.metric : "",
      target: num(k.target, 0),
      current: num(k.current, 0),
      unit: typeof k.unit === "string" ? k.unit : "",
      verified: k.verified === true,
      source: typeof k.source === "string" ? k.source : null,
    };
  });
}

/**
 * Venture Memory & Planning routes (#197, ADR-0197) under `/workspaces/:wid/ventures/:ideaId/...`. Thin
 * adapters over {@link VentureMemoryService} — identity + the #19 `assertWorkspace` IDOR boundary, then a
 * single service call. Recording memory + reading beliefs/OKRs/brief/plans/playbooks are ALWAYS available
 * (tenant-scoped); the proactive weekly tick is gated by `ventureMemory.enabled`. The `/beliefs` route is
 * the owner-visible "what does it believe" surface (AC5); `/brief` is exactly the text injected into a
 * venture session (AC1).
 */
export interface VentureMemoryRoutesOptions {
  service: VentureMemoryService;
}

export async function ventureMemoryRoutes(
  app: FastifyInstance,
  opts: VentureMemoryRoutesOptions,
): Promise<void> {
  const { service } = opts;

  /** Record one venture memory (a session writing what it learned). */
  app.post("/workspaces/:wid/ventures/:ideaId/memory", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, ideaId } = req.params as { wid: string; ideaId: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as {
      kind?: string;
      text?: string;
      why?: string;
      sourceRef?: string;
    };
    if (!isVentureMemoryKind(body.kind)) {
      return reply
        .code(400)
        .send({ error: "kind must be one of decision, worked, failed, customer_voice, brand_fact" });
    }
    if (!body.text || body.text.trim().length === 0) {
      return reply.code(400).send({ error: "text is required" });
    }
    const result = await service.recordMemory({
      workspaceId: wid,
      ideaId,
      kind: body.kind,
      text: body.text,
      why: body.why ?? null,
      sourceRef: body.sourceRef ?? null,
      createdByMemberId: id.memberId,
    });
    return reply.code(201).send(result);
  });

  /** The venture's current beliefs (fresh, deduped) — what a new session retrieves. */
  app.get("/workspaces/:wid/ventures/:ideaId/memory", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, ideaId } = req.params as { wid: string; ideaId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.recallMemories(wid, ideaId);
  });

  /** The owner-visible "what does it believe" surface: fresh / superseded / needs-review (AC5). */
  app.get("/workspaces/:wid/ventures/:ideaId/beliefs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, ideaId } = req.params as { wid: string; ideaId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.beliefs(wid, ideaId);
  });

  /** The exact brief injected into a new venture session (memory + OKR drift) — AC1. */
  app.get("/workspaces/:wid/ventures/:ideaId/brief", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, ideaId } = req.params as { wid: string; ideaId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const text = await service.sessionBrief(wid, ideaId);
    return reply.code(200).send({ ideaId, text });
  });

  /** Declare a venture OKR (an objective + measurable key results). Always available, tenant-scoped. */
  app.post("/workspaces/:wid/ventures/:ideaId/okrs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, ideaId } = req.params as { wid: string; ideaId: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as { objective?: string; keyResults?: unknown; periodKey?: string };
    if (!body.objective || body.objective.trim().length === 0) {
      return reply.code(400).send({ error: "objective is required" });
    }
    const keyResults = readKeyResults(body.keyResults);
    if (keyResults.length === 0) {
      return reply.code(400).send({ error: "at least one key result is required" });
    }
    const okr = await service.recordOkr({
      workspaceId: wid,
      ideaId,
      objective: body.objective,
      keyResults,
      periodKey: body.periodKey,
    });
    return reply.code(201).send(okr);
  });

  /** The venture's OKRs with computed drift flags (AC4). */
  app.get("/workspaces/:wid/ventures/:ideaId/okrs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, ideaId } = req.params as { wid: string; ideaId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.okrDrift(wid, ideaId);
  });

  /** The cross-venture playbooks available to this workspace (AC3). */
  app.get("/workspaces/:wid/playbooks", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.listPlaybooks(wid);
  });

  /** Run one weekly planning pass: draft + #13-gate each venture's plan. Default-OFF (no-op if disabled). */
  app.post("/workspaces/:wid/ventures/planning/tick", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const result = await service.tick(wid);
    return reply.code(200).send(result);
  });
}
