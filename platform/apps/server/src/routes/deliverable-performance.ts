import type { FastifyInstance } from "fastify";
import { assertWorkspace, requireIdentity } from "../auth/guard.js";
import {
  getDeliverablePerformance,
  listRankedDeliverablePerformance,
  recordDeliverablePerformance,
  type DeliverablePerformanceSource,
} from "../db/repositories/delivery.js";
import { DELIVERABLE_PERFORMANCE_SOURCES } from "../db/schema/index.js";

/**
 * Per-deliverable performance (#869): measured views/engagement/conversions are tied to a delivery receipt,
 * so customers can inspect one shipped artifact or rank all artifacts instead of reading workspace blends.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function performanceSource(value: unknown): DeliverablePerformanceSource | null {
  return typeof value === "string" &&
    (DELIVERABLE_PERFORMANCE_SOURCES as readonly string[]).includes(value)
    ? (value as DeliverablePerformanceSource)
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 240) : null;
}

function measuredAt(value: unknown): Date {
  if (typeof value !== "string") return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function deliverablePerformanceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/delivery/receipts/:receiptId/performance", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { receiptId } = req.params as { receiptId: string };
    if (!UUID_RE.test(receiptId)) return reply.code(400).send({ error: "invalid receipt id" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = performanceSource(body.source) ?? "manual";
    const views = nonnegativeInteger(body.views);
    const engagements = nonnegativeInteger(body.engagements);
    const conversions = nonnegativeInteger(body.conversions);
    if (views === null || engagements === null || conversions === null) {
      return reply.code(400).send({ error: "views, engagements, and conversions must be nonnegative integers" });
    }

    const recorded = await recordDeliverablePerformance({
      workspaceId: id.workspaceId,
      deliveryReceiptId: receiptId,
      source,
      views,
      engagements,
      conversions,
      externalMetricRef: optionalText(body.externalMetricRef),
      measuredAt: measuredAt(body.measuredAt),
    });
    if (!recorded) return reply.code(404).send({ error: "shipped delivery receipt not found" });
    return reply.code(202).send({ performance: recorded.performance });
  });

  app.get("/me/deliverables/:receiptId/performance", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { receiptId } = req.params as { receiptId: string };
    if (!UUID_RE.test(receiptId)) return reply.code(400).send({ error: "invalid receipt id" });
    const performance = await getDeliverablePerformance(id.workspaceId, receiptId);
    if (!performance) return reply.code(404).send({ error: "delivery receipt not found" });
    return { performance };
  });

  app.get("/me/deliverables/performance", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return { deliverables: await listRankedDeliverablePerformance(id.workspaceId) };
  });

  app.get("/workspaces/:wid/deliverables/performance", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return { deliverables: await listRankedDeliverablePerformance(wid) };
  });
}
