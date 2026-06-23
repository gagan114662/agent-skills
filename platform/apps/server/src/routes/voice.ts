import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { verifyWebhookSignature, WebhookVerificationError } from "../billing/webhook.js";
import {
  CustomerVoiceService,
  VoiceNotFoundError,
  VoiceStateError,
} from "../voice/service.js";
import type { VoiceSourceKind } from "../voice/classify.js";

/**
 * Customer Voice Loop routes (#114, ADR-0114). Inbound is a signed webhook (`POST /voice/webhook/:wid`,
 * the #98 HMAC pattern) that turns a customer message into a ticket + a classified `user_voice` insight;
 * the tenant routes (under `/workspaces/:wid/voice`) read the inbox / metrics / digest and submit a reply
 * for #13 approval. Every tenant route is `requireIdentity` + `assertWorkspace`-guarded (the #3 boundary).
 * The webhook is `:wid`-scoped and disabled (503) until a `VOICE_WEBHOOK_SECRET` is configured.
 */
export interface VoiceRoutesOptions {
  service: CustomerVoiceService;
}

const FEEDBACK_KINDS: readonly Exclude<VoiceSourceKind, "support_ticket">[] = [
  "checkout_abandon",
  "cancellation",
  "nps",
  "brand_mention",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function voiceRoutes(app: FastifyInstance, opts: VoiceRoutesOptions): Promise<void> {
  const { service } = opts;

  // Inbound webhook in an encapsulated scope so the RAW body is parsed as a Buffer ONLY for this route
  // (signature verification needs the exact bytes). Mirrors the #98 billing webhook registration.
  await app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );
    webhookScope.post("/voice/webhook/:wid", async (req, reply) => {
      const { wid } = req.params as { wid: string };
      const secret = await service.webhookSecret(wid);
      if (!secret) {
        return reply.code(503).send({ error: "voice webhook not configured for this workspace" });
      }
      const raw = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body ?? "");
      const signature = req.headers["voice-signature"];
      try {
        verifyWebhookSignature(raw, typeof signature === "string" ? signature : undefined, secret);
      } catch (err) {
        if (err instanceof WebhookVerificationError) return reply.code(400).send({ error: err.message });
        throw err;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return reply.code(400).send({ error: "invalid JSON body" });
      }

      const kind = String(payload.kind ?? "");
      const sourceRef = typeof payload.sourceRef === "string" ? payload.sourceRef.trim() : "";
      if (!sourceRef) return reply.code(400).send({ error: "sourceRef is required" });
      // Validate ventureIdeaId as a UUID before it reaches the DB (a malformed value would otherwise be a
      // 500 on the uuid column / FK lookup). Absent/null is fine (the signal is workspace-level).
      let ventureIdeaId: string | null = null;
      if (payload.ventureIdeaId !== undefined && payload.ventureIdeaId !== null) {
        if (typeof payload.ventureIdeaId !== "string" || !UUID_RE.test(payload.ventureIdeaId)) {
          return reply.code(400).send({ error: "ventureIdeaId must be a UUID" });
        }
        ventureIdeaId = payload.ventureIdeaId;
      }

      try {
        if (kind === "support") {
          const result = await service.ingestTicket({
            workspaceId: wid,
            channel: typeof payload.channel === "string" ? payload.channel : "webhook",
            sourceRef,
            body: typeof payload.body === "string" ? payload.body : "",
            subject: typeof payload.subject === "string" ? payload.subject : null,
            contact: typeof payload.contact === "string" ? payload.contact : null,
            ventureIdeaId,
          });
          return reply
            .code(result.deduped ? 200 : 201)
            .send({ ticketId: result.ticket.id, insightId: result.insight.id, deduped: result.deduped });
        }
        if ((FEEDBACK_KINDS as readonly string[]).includes(kind)) {
          // An NPS signal must carry a valid 0–10 integer score (it drives the classifier band and the
          // nps_score CHECK). Validate here so a bad value is a 400, not a 500 from the DB constraint.
          let npsScore: number | null = null;
          if (kind === "nps") {
            if (typeof payload.npsScore !== "number" || !Number.isInteger(payload.npsScore) || payload.npsScore < 0 || payload.npsScore > 10) {
              return reply.code(400).send({ error: "npsScore must be an integer between 0 and 10 for an nps signal" });
            }
            npsScore = payload.npsScore;
          } else if (typeof payload.npsScore === "number" && Number.isInteger(payload.npsScore) && payload.npsScore >= 0 && payload.npsScore <= 10) {
            npsScore = payload.npsScore;
          }
          const result = await service.ingestFeedback({
            workspaceId: wid,
            sourceKind: kind as Exclude<VoiceSourceKind, "support_ticket">,
            sourceRef,
            text: typeof payload.text === "string" ? payload.text : "",
            npsScore,
            ventureIdeaId,
          });
          return reply
            .code(result.deduped ? 200 : 201)
            .send({ insightId: result.insight.id, deduped: result.deduped });
        }
        return reply
          .code(400)
          .send({ error: "kind must be support | checkout_abandon | cancellation | nps | brand_mention" });
      } catch (err) {
        if (err instanceof VoiceNotFoundError) return reply.code(404).send({ error: err.message });
        throw err;
      }
    });
  });

  /** List support tickets (`?needsHuman=1` filters to the inbox that still needs a human). */
  app.get("/workspaces/:wid/voice/tickets", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const { needsHuman } = req.query as { needsHuman?: string };
    return reply.send(await service.list(wid, { needsHuman: needsHuman === "1" || needsHuman === "true" }));
  });

  /** Read one support ticket (404 cross-workspace — no leak). */
  app.get("/workspaces/:wid/voice/tickets/:tid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, tid } = req.params as { wid: string; tid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      return reply.send(await service.get(wid, tid));
    } catch (err) {
      if (err instanceof VoiceNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** Submit a reply for #13 approval (sensitive-by-default external.send) — never sends. */
  app.post("/workspaces/:wid/voice/tickets/:tid/reply", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, tid } = req.params as { wid: string; tid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) return reply.code(400).send({ error: "body (the reply text) is required" });
    try {
      const result = await service.submitReply(wid, tid, id.memberId, text);
      return reply.code(202).send(result);
    } catch (err) {
      if (err instanceof VoiceNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof VoiceStateError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  /** The churn/NPS roll-up (optionally scoped to one venture idea via `?ventureIdeaId=`). */
  app.get("/workspaces/:wid/voice/metrics", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const { ventureIdeaId } = req.query as { ventureIdeaId?: string };
    return reply.send(await service.metrics(wid, ventureIdeaId));
  });

  /** The weekly voice-of-customer digest. */
  app.get("/workspaces/:wid/voice/digest", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send(await service.digest(wid));
  });

  /** Classified brand mention feed (#618): negative/high-risk mentions carry `needsResponse=true`. */
  app.get("/workspaces/:wid/voice/mentions", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send(await service.brandMentions(wid));
  });
}
