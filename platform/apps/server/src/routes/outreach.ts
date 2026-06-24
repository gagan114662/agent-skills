import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { OutreachService, OutreachValidationError } from "../outreach/service.js";
import { clampOutreachMessagesLimit } from "../db/repositories/outreach.js";

/**
 * Outreach engine routes (#225, ADR-0225) under `/workspaces/:wid/outreach`. Thin adapters over
 * {@link OutreachService} — identity + the #19 `assertWorkspace` IDOR boundary, then a single service call.
 *
 * There is NO send endpoint here. `POST /queue` only PARKS a #13 approval (the exact recipient + content
 * shown on the card); the actual send happens only after the owner approves, through the recorded-only
 * `outreach.send` executor. So no route can cause an autonomous send (premortem #200).
 */
export interface OutreachRoutesOptions {
  service: OutreachService;
}

export async function outreachRoutes(app: FastifyInstance, opts: OutreachRoutesOptions): Promise<void> {
  const { service } = opts;

  /** Preview a composed (problem-led) message for a (prospect, brief) pair — DATA only, nothing queued. */
  app.get("/workspaces/:wid/outreach/draft", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { prospectKey?: string; buyerBriefId?: string; ideaId?: string; productName?: string };
    if (!q.prospectKey || !q.buyerBriefId) {
      return reply.code(400).send({ error: "prospectKey and buyerBriefId are required" });
    }
    try {
      return await service.draft(wid, {
        prospectKey: q.prospectKey,
        buyerBriefId: q.buyerBriefId,
        ideaId: q.ideaId ?? null,
        productName: q.productName,
      });
    } catch (err) {
      if (err instanceof OutreachValidationError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Compose + PARK an outreach message for one-tap owner approval. Never sends. 202 with the parked
   * approval id (pending_approval), 200 with blocked/rate_limited when the channel can't carry it.
   */
  app.post("/workspaces/:wid/outreach/queue", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = (req.body ?? {}) as {
      prospectKey?: string;
      buyerBriefId?: string;
      ideaId?: string;
      productName?: string;
    };
    if (!b.prospectKey || !b.buyerBriefId) {
      return reply.code(400).send({ error: "prospectKey and buyerBriefId are required" });
    }
    try {
      const result = await service.queue(wid, {
        prospectKey: b.prospectKey,
        buyerBriefId: b.buyerBriefId,
        ideaId: b.ideaId ?? null,
        productName: b.productName,
        requesterMemberId: id.memberId,
      });
      return reply.code(result.status === "pending_approval" ? 202 : 200).send(result);
    } catch (err) {
      if (err instanceof OutreachValidationError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Record an EXTERNAL receipt (reply/meeting/signup, each with a non-empty externalRef). This is the only
   * thing that moves an experiment + the #222 GTM pipeline (premortem #200 §2). Idempotent. 201.
   */
  app.post("/workspaces/:wid/outreach/receipts", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = (req.body ?? {}) as {
      messageId?: string;
      kind?: string;
      externalRef?: string;
      replyBody?: string | null;
      replyFrom?: string | null;
      replySubject?: string | null;
    };
    if (!b.messageId || !b.kind || !b.externalRef) {
      return reply.code(400).send({ error: "messageId, kind, and externalRef are required" });
    }
    try {
      const { receipt, created } = await service.recordReceipt(wid, {
        messageId: b.messageId,
        kind: b.kind,
        externalRef: b.externalRef,
        replyBody: typeof b.replyBody === "string" ? b.replyBody : null,
        replyFrom: typeof b.replyFrom === "string" ? b.replyFrom : null,
        replySubject: typeof b.replySubject === "string" ? b.replySubject : null,
      });
      return reply.code(201).send({ receipt, created });
    } catch (err) {
      if (err instanceof OutreachValidationError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  /** The message experiments (running/concluded), concluded from external receipts only. Read-only. */
  app.get("/workspaces/:wid/outreach/experiments", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { ideaId?: string };
    return service.experiments(wid, q.ideaId);
  });

  /** List the workspace's outreach messages (audit), newest first. Read-only. */
  app.get("/workspaces/:wid/outreach/messages", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { ideaId?: string; limit?: string };
    const limit = clampOutreachMessagesLimit(q.limit ? Number.parseInt(q.limit, 10) : undefined);
    return service.listMessages(wid, { ideaId: q.ideaId, limit });
  });

  app.get("/workspaces/:wid/outreach/replies", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return { replies: await service.replyThreads(wid) };
  });
}
