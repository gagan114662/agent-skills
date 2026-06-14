import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { DiscoveryService, DiscoveryValidationError } from "../discovery/service.js";

/**
 * Customer Discovery Engine routes (#222, ADR-0222) under `/workspaces/:wid/discovery`. Thin adapters over
 * {@link DiscoveryService} — identity + the #19 `assertWorkspace` IDOR boundary, then a single service
 * call. READ-ONLY surface: define owner signals, ingest real product/channel receipts, and READ the
 * ranked queue / top-N prospects / PQL events / GTM pipeline. Nothing here sends — outreach is #225.
 */
export interface DiscoveryRoutesOptions {
  service: DiscoveryService;
}

export async function discoveryRoutes(
  app: FastifyInstance,
  opts: DiscoveryRoutesOptions,
): Promise<void> {
  const { service } = opts;

  /** Owner defines (or re-defines) a qualifying signal (power-user threshold, usage trend, etc.). */
  app.post("/workspaces/:wid/discovery/signal-defs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as {
      ideaId?: string;
      kind?: string;
      label?: string;
      threshold?: number;
      windowDays?: number;
      role?: string | null;
      weight?: number;
      enabled?: boolean;
    };
    try {
      const def = await service.defineSignal(wid, {
        ideaId: body.ideaId ?? null,
        kind: body.kind ?? "",
        label: body.label ?? "",
        threshold: body.threshold,
        windowDays: body.windowDays,
        role: body.role ?? null,
        weight: body.weight,
        enabled: body.enabled,
        createdByMemberId: id.memberId,
      });
      return reply.code(201).send(def);
    } catch (err) {
      if (err instanceof DiscoveryValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  /** List the workspace's owner-defined qualifying signals. */
  app.get("/workspaces/:wid/discovery/signal-defs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.listSignalDefs(wid);
  });

  /** Ingest one real product/channel receipt → re-evaluates defs → may emit PQLs (READ-ONLY, no send). */
  app.post("/workspaces/:wid/discovery/signals", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as {
      ideaId?: string;
      prospectKey?: string;
      kind?: string;
      value?: number;
      role?: string | null;
      source?: string;
      externalRef?: string | null;
      occurredAt?: string;
      detail?: Record<string, unknown>;
    };
    try {
      const result = await service.ingestSignal(wid, {
        ideaId: body.ideaId ?? null,
        prospectKey: body.prospectKey ?? "",
        kind: body.kind ?? "",
        value: body.value,
        role: body.role ?? null,
        source: body.source,
        externalRef: body.externalRef ?? null,
        occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
        detail: body.detail,
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof DiscoveryValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  /** The daily ranked discovery queue (top-N prospects to reach out to now). `?limit=` and `?ideaId=`. */
  app.get("/workspaces/:wid/discovery/queue", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = (req.query ?? {}) as { ideaId?: string; limit?: string };
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return service.queue(wid, {
      ideaId: q.ideaId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  });

  /** The per-venture ranked queue scoped to one idea. */
  app.get("/workspaces/:wid/discovery/queue/ventures/:vid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = (req.query ?? {}) as { limit?: string };
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    return service.queue(wid, { ideaId: vid, limit: Number.isFinite(limit) ? limit : undefined });
  });

  /** The 5-stage GTM pipeline metrics (per-stage counts + stage-to-stage conversions). */
  app.get("/workspaces/:wid/discovery/pipeline", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = (req.query ?? {}) as { ideaId?: string };
    return service.pipelineSummary(wid, q.ideaId);
  });

  /** The PQL event stream (the stable seam #223/#225 consume). */
  app.get("/workspaces/:wid/discovery/pql-events", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = (req.query ?? {}) as { ideaId?: string };
    return service.listPqlEvents(wid, q.ideaId);
  });
}
