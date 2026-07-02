import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { clampIntentLeadsLimit } from "../db/repositories/intent-scanner.js";
import {
  IntentScannerService,
  IntentScannerValidationError,
} from "../intent-scanner/service.js";
import { isIntentLeadStatus, isIntentSource } from "../intent-scanner/types.js";

export interface IntentScannerRoutesOptions {
  service: IntentScannerService;
}

export async function intentScannerRoutes(
  app: FastifyInstance,
  opts: IntentScannerRoutesOptions,
): Promise<void> {
  const { service } = opts;

  app.get("/workspaces/:wid/intent-scanner/monitors", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return { monitors: await service.listMonitors(wid) };
  });

  app.post("/workspaces/:wid/intent-scanner/monitors", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = readMonitorBody(req.body);
    if (!isIntentSource(body.source)) {
      return reply.code(422).send({ error: "source must be reddit or x" });
    }
    try {
      const monitor = await service.createMonitor({
        workspaceId: wid,
        source: body.source,
        label: body.label,
        subreddits: body.subreddits,
        keywords: body.keywords,
        competitors: body.competitors,
        questionPatterns: body.questionPatterns,
        cadenceMinutes: body.cadenceMinutes,
        minScore: body.minScore,
        createdByMemberId: id.memberId,
      });
      return reply.code(201).send({ monitor });
    } catch (err) {
      if (err instanceof IntentScannerValidationError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/workspaces/:wid/intent-scanner/leads", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { status?: string; limit?: string };
    if (q.status && !isIntentLeadStatus(q.status)) {
      return reply.code(422).send({ error: "invalid lead status" });
    }
    const status = q.status && isIntentLeadStatus(q.status) ? q.status : undefined;
    const limit = clampIntentLeadsLimit(q.limit ? Number.parseInt(q.limit, 10) : undefined);
    return { leads: await service.listLeads(wid, { status, limit }) };
  });

  app.post("/workspaces/:wid/intent-scanner/scan", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.code(202).send({ scan: await service.tickWorkspace(wid) });
  });

  app.post("/workspaces/:wid/intent-scanner/leads/:leadId/queue-reply", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, leadId } = req.params as { wid: string; leadId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      const lead = await service.queueReply(wid, leadId, id.memberId);
      return reply.code(202).send({ lead });
    } catch (err) {
      if (err instanceof IntentScannerValidationError) {
        return reply.code(err.message === "lead not found" ? 404 : 422).send({ error: err.message });
      }
      throw err;
    }
  });
}

function readMonitorBody(body: unknown): {
  source?: string;
  label?: string;
  subreddits?: string[];
  keywords?: string[];
  competitors?: string[];
  questionPatterns?: string[];
  cadenceMinutes?: number;
  minScore?: number;
} {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    source: typeof value.source === "string" ? value.source : undefined,
    label: typeof value.label === "string" ? value.label : undefined,
    subreddits: readStringArray(value.subreddits),
    keywords: readStringArray(value.keywords),
    competitors: readStringArray(value.competitors),
    questionPatterns: readStringArray(value.questionPatterns),
    cadenceMinutes: typeof value.cadenceMinutes === "number" ? value.cadenceMinutes : undefined,
    minScore: typeof value.minScore === "number" ? value.minScore : undefined,
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
