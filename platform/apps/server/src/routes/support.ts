import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { verifyWebhookSignature, WebhookVerificationError } from "../billing/webhook.js";
import { SupportDeskService, SupportNotFoundError } from "../support/service.js";
import { kbSlug } from "../support/kb.js";
import { RECEIPT_KINDS } from "../db/schema/support.js";
import { recordWebhookSignatureFailure } from "../observability/metrics.js";

/**
 * Support Desk routes (#190, ADR-0190). Two signed inbound hooks (the #98 HMAC pattern) — the embeddable
 * widget / email-forward intake and the provider delivery/resolution receipt — plus tenant-guarded reads
 * and curation under `/workspaces/:wid/support`. Every tenant route is `requireIdentity` + `assertWorkspace`
 * (the #3 boundary); the inbound hooks are `:wid`-scoped and 503 until a `SUPPORT_WEBHOOK_SECRET` is set.
 *
 * The widget intake ingests (reusing #114) AND triages — but an autonomous send only happens when every
 * fence in `decideSupportRouting` passes AND a deployment wired an `AutoApprover` (the default has none),
 * so out of the box every reply still lands as a #13 human approval.
 */
export interface SupportRoutesOptions {
  service: SupportDeskService;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only EXTERNAL receipt kinds are accepted from a provider webhook; `auto_sent` is an internal-only marker.
const EXTERNAL_RECEIPT_KINDS = RECEIPT_KINDS.filter((k) => k !== "auto_sent");

export async function supportRoutes(app: FastifyInstance, opts: SupportRoutesOptions): Promise<void> {
  const { service } = opts;

  // ---- inbound signed hooks (raw-body scope) --------------------------------------------------------
  await app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );

    async function verify(wid: string, raw: string, sig: unknown): Promise<{ ok: true } | { code: number; error: string }> {
      const secret = await service.webhookSecret(wid);
      if (!secret) return { code: 503, error: "support webhook not configured for this workspace" };
      try {
        verifyWebhookSignature(raw, typeof sig === "string" ? sig : undefined, secret);
        return { ok: true };
      } catch (err) {
        if (err instanceof WebhookVerificationError) return { code: 400, error: err.message };
        throw err;
      }
    }

    /** The embeddable chat-widget / email-forward intake: a customer message → ticket → triage. */
    webhookScope.post("/support/widget/:wid", async (req, reply) => {
      const { wid } = req.params as { wid: string };
      const raw = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body ?? "");
      const v = await verify(wid, raw, req.headers["support-signature"]);
      if (!("ok" in v) && v.code === 400) {
        req.log.warn({ provider: "support", workspaceId: wid, reason: v.error }, "webhook signature verification failed");
        recordWebhookSignatureFailure("support", v.error);
      }
      if (!("ok" in v)) return reply.code(v.code).send({ error: v.error });

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return reply.code(400).send({ error: "invalid JSON body" });
      }
      const sourceRef = typeof payload.sourceRef === "string" ? payload.sourceRef.trim() : "";
      const body = typeof payload.body === "string" ? payload.body : "";
      if (!sourceRef) return reply.code(400).send({ error: "sourceRef is required" });
      if (!body.trim()) return reply.code(400).send({ error: "body is required" });
      let ventureIdeaId: string | null = null;
      if (payload.ventureIdeaId !== undefined && payload.ventureIdeaId !== null) {
        if (typeof payload.ventureIdeaId !== "string" || !UUID_RE.test(payload.ventureIdeaId)) {
          return reply.code(400).send({ error: "ventureIdeaId must be a UUID" });
        }
        ventureIdeaId = payload.ventureIdeaId;
      }

      const outcome = await service.intakeWebhook({
        workspaceId: wid,
        channel: typeof payload.channel === "string" ? payload.channel : "widget",
        sourceRef,
        body,
        subject: typeof payload.subject === "string" ? payload.subject : null,
        contact: typeof payload.contact === "string" ? payload.contact : null,
        ventureIdeaId,
      });
      return reply.code(202).send({
        ticketId: outcome.ticket.id,
        route: outcome.route,
        autoSent: outcome.autoSent,
        approvalRequestId: outcome.approvalRequestId,
        receipts: outcome.receipts,
        escalationReasons: outcome.escalationReasons,
      });
    });

    /** A provider delivery/resolution receipt — the ONLY trustworthy resolution signal (premortem §2). */
    webhookScope.post("/support/receipts/:wid", async (req, reply) => {
      const { wid } = req.params as { wid: string };
      const raw = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body ?? "");
      const v = await verify(wid, raw, req.headers["support-signature"]);
      if (!("ok" in v) && v.code === 400) {
        req.log.warn({ provider: "support", workspaceId: wid, reason: v.error }, "webhook signature verification failed");
        recordWebhookSignatureFailure("support", v.error);
      }
      if (!("ok" in v)) return reply.code(v.code).send({ error: v.error });

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return reply.code(400).send({ error: "invalid JSON body" });
      }
      const kind = String(payload.kind ?? "");
      const providerRef = typeof payload.providerRef === "string" ? payload.providerRef.trim() : "";
      if (!(EXTERNAL_RECEIPT_KINDS as readonly string[]).includes(kind)) {
        return reply.code(400).send({ error: `kind must be one of ${EXTERNAL_RECEIPT_KINDS.join(" | ")}` });
      }
      if (!providerRef) return reply.code(400).send({ error: "providerRef is required" });
      let ticketId: string | null = null;
      if (payload.ticketId !== undefined && payload.ticketId !== null) {
        if (typeof payload.ticketId !== "string" || !UUID_RE.test(payload.ticketId)) {
          return reply.code(400).send({ error: "ticketId must be a UUID" });
        }
        ticketId = payload.ticketId;
      }
      const result = await service.ingestReceipt({
        workspaceId: wid,
        ticketId,
        kind,
        providerRef,
        detail: typeof payload.detail === "string" ? payload.detail : null,
      });
      return reply.code(result.deduped ? 200 : 201).send({ receiptId: result.receipt.id, deduped: result.deduped });
    });
  });

  // ---- tenant-guarded reads + curation --------------------------------------------------------------

  /** List the venture knowledge base (`?category=` filters). */
  app.get("/workspaces/:wid/support/kb", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const { category } = req.query as { category?: string };
    return reply.send(await service.listKb(wid, category ? { category } : undefined));
  });

  /** Curate a KB entry by hand (AC2). */
  app.post("/workspaces/:wid/support/kb", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof b.title === "string" ? b.title.trim() : "";
    const body = typeof b.body === "string" ? b.body.trim() : "";
    const category = typeof b.category === "string" ? b.category.trim() : "";
    if (!title || !body || !category) {
      return reply.code(400).send({ error: "title, body and category are required" });
    }
    let ventureIdeaId: string | null = null;
    if (b.ventureIdeaId !== undefined && b.ventureIdeaId !== null) {
      if (typeof b.ventureIdeaId !== "string" || !UUID_RE.test(b.ventureIdeaId)) {
        return reply.code(400).send({ error: "ventureIdeaId must be a UUID" });
      }
      ventureIdeaId = b.ventureIdeaId;
    }
    const { entry, deduped } = await service.upsertKb({
      workspaceId: wid,
      ventureIdeaId,
      slug: kbSlug(title),
      title,
      body,
      category,
      source: "manual",
      sourceTicketId: null,
      provenance: `manual:${id.memberId}`,
      createdByMemberId: id.memberId,
    });
    return reply.code(deduped ? 200 : 201).send({ id: entry.id, slug: entry.slug, deduped });
  });

  /** Mine recurring real prospect questions into objection FAQ KB drafts (#609). */
  app.post("/workspaces/:wid/support/objections/refresh", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = (req.body ?? {}) as { minCount?: unknown };
    const minCount =
      typeof b.minCount === "number" && Number.isFinite(b.minCount) ? Math.trunc(b.minCount) : undefined;
    const result = await service.refreshObjectionFaq(wid, {
      minCount,
      createdByMemberId: id.memberId,
    });
    return reply.code(200).send(result);
  });

  /** Manually (re)triage a ticket as the calling member — routes per the bounded-autonomy gate. */
  app.post("/workspaces/:wid/support/tickets/:tid/triage", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, tid } = req.params as { wid: string; tid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      const outcome = await service.triageTicket(wid, tid, id.memberId);
      return reply.code(200).send({
        ticketId: outcome.ticket.id,
        route: outcome.route,
        reason: outcome.reason,
        autoSent: outcome.autoSent,
        approvalRequestId: outcome.approvalRequestId,
        receipts: outcome.receipts,
        escalationReasons: outcome.escalationReasons,
      });
    } catch (err) {
      if (err instanceof SupportNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** Resolve a ticket by distilling its resolution into a KB entry (AC4 — the desk learns). */
  app.post("/workspaces/:wid/support/tickets/:tid/resolve", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, tid } = req.params as { wid: string; tid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const resolution = typeof b.resolution === "string" ? b.resolution.trim() : "";
    if (!resolution) return reply.code(400).send({ error: "resolution is required" });
    try {
      const { entry, deduped } = await service.learnFromResolved(wid, tid, resolution, id.memberId);
      return reply.code(deduped ? 200 : 201).send({ kbEntryId: entry.id, slug: entry.slug, deduped });
    } catch (err) {
      if (err instanceof SupportNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** First-response SLA breaches (the founder-brief feed). */
  app.get("/workspaces/:wid/support/sla", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send(await service.slaBreaches(wid));
  });

  /** Resolution metrics — verified (external receipt) vs UNVERIFIED (status-only). */
  app.get("/workspaces/:wid/support/metrics", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send(await service.resolutionMetrics(wid));
  });
}
