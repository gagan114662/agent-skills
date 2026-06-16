import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { ReachService } from "../reach/service.js";
import { isReachReceiptKind } from "../reach/types.js";

/**
 * Reach routes (#280) under `/me/reach/*` — thin adapters over {@link ReachService}, scoped to the caller's
 * workspace (#3).
 *
 *  - `POST /me/reach/run` runs ONE batch of the outbound loop now (the cron entrypoint — an external
 *    scheduler hits this on an interval, or an owner triggers it manually). It auto-sends within the
 *    per-domain cap + suppression; a PAID data source parks a money-gated #13 request instead of spending.
 *  - `POST /me/reach/receipts` records an external engagement receipt (open/reply/booked) — the only
 *    source of measurement truth; a reply stops that prospect's cadence.
 *  - `GET /me/reach/summary` returns the headline numbers (prospects reached, sent, replies, booked).
 *
 * Running a batch is NOT money (sending a marketing message is autonomous under the caps), so these
 * carry no #13 gate; the only money path (buying paid data credits) is gated inside the service.
 */
export interface ReachRoutesOptions {
  service: ReachService;
}

export async function reachRoutes(app: FastifyInstance, opts: ReachRoutesOptions): Promise<void> {
  const { service } = opts;

  app.post("/me/reach/run", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.runBatch(id.workspaceId);
  });

  app.get("/me/reach/summary", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.summary(id.workspaceId);
  });

  app.post("/me/reach/receipts", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const body = (req.body ?? {}) as {
      contactKey?: unknown;
      kind?: unknown;
      externalRef?: unknown;
      occurredAt?: unknown;
    };
    if (!body.contactKey || !body.kind || !body.externalRef) {
      return reply.code(400).send({ error: "contactKey, kind, and externalRef are required" });
    }
    if (
      typeof body.contactKey !== "string" ||
      typeof body.kind !== "string" ||
      typeof body.externalRef !== "string"
    ) {
      return reply.code(400).send({ error: "contactKey, kind, and externalRef must be strings" });
    }
    if (!isReachReceiptKind(body.kind)) {
      return reply.code(400).send({ error: "kind must be one of open|reply|booked" });
    }
    const occurredAt =
      typeof body.occurredAt === "string" || typeof body.occurredAt === "number"
        ? new Date(body.occurredAt)
        : undefined;
    return service.recordReceipt(id.workspaceId, {
      contactKey: body.contactKey,
      kind: body.kind,
      externalRef: body.externalRef,
      occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : undefined,
    });
  });
}
