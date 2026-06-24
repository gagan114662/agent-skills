import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { resolveAcquisitionCaps } from "../acquisition/caps.js";
import {
  EspWebhookVerificationError,
  verifyEspSignature,
  parseEspBody,
  decideEspSuppressions,
  parseInboundEmailReply,
} from "../acquisition/webhook.js";
import {
  addSuppression,
  listSuppressions,
} from "../db/repositories/acquisition.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { SUPPRESSION_REASONS, type SuppressionReason } from "../acquisition/compliance.js";
import { decideOneClickUnsubscribe } from "../email/one-click-unsubscribe.js";
import type { OutreachService } from "../outreach/service.js";
import type { ReachService } from "../reach/service.js";
import { recordWebhookSignatureFailure } from "../observability/metrics.js";

/**
 * Acquisition execution routes (#189, ADR-0189).
 *
 *   - `GET  /me/acquisition/suppressions` — read the email suppression list (read-only, always works).
 *   - `POST /me/acquisition/suppressions` — manually suppress a recipient (identity-gated; gated on the
 *     acquisition flag so it's owner-workspace-first).
 *   - `POST /acquisition/esp/webhook/:wid` — the **unauthenticated but signature-verified** ESP webhook
 *     receiver: bounce/complaint events add to the suppression list (deliverability enforced in code).
 *
 * The webhook secret is resolved from the #192 sealed vault (the ESP service credentials), never config.
 */
export interface AcquisitionRoutesOptions {
  outreach?: OutreachService;
  reach?: ReachService;
}

export async function acquisitionRoutes(
  app: FastifyInstance,
  opts: AcquisitionRoutesOptions = {},
): Promise<void> {
  function caps(workspaceId: string) {
    return resolveAcquisitionCaps(loadConfig(workspaceId).acquisition);
  }

  // The suppression list — read-only, always available so the console can render it.
  app.get("/me/acquisition/suppressions", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const rows = await listSuppressions(identity.workspaceId);
    return { suppressions: rows };
  });

  // Manually suppress a recipient (e.g. an inbound unsubscribe). Gated on the acquisition flag.
  app.post("/me/acquisition/suppressions", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (!caps(identity.workspaceId).enabled) {
      return reply.code(409).send({ error: "acquisition not enabled for this workspace" });
    }
    const body = (req.body ?? {}) as { recipient?: unknown; reason?: unknown };
    if (typeof body.recipient !== "string" || body.recipient.trim().length === 0) {
      return reply.code(400).send({ error: "recipient required" });
    }
    const reason: SuppressionReason =
      typeof body.reason === "string" && (SUPPRESSION_REASONS as readonly string[]).includes(body.reason)
        ? (body.reason as SuppressionReason)
        : "manual";
    await addSuppression({
      workspaceId: identity.workspaceId,
      recipient: body.recipient,
      reason,
      source: "manual",
    });
    return reply.code(201).send({ suppressed: true });
  });

  // The signature-verified ESP webhook receiver. Its own plugin scope parses the RAW body as a Buffer
  // (required to verify the HMAC over the exact bytes) — the rest of the app keeps normal JSON parsing.
  await app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    // The RFC 8058 one-click unsubscribe POST arrives as `application/x-www-form-urlencoded` (body
    // `List-Unsubscribe=One-Click`). Its handler reads the recipient + token from the query string, not the
    // body, so a catch-all buffer passthrough lets any/no body through without a 415.
    webhookScope.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    webhookScope.post("/acquisition/esp/webhook/:wid", async (req, reply) => {
      const { wid } = req.params as { wid: string };
      const c = caps(wid);
      if (!c.enabled || !c.channels.email) {
        return reply.code(409).send({ error: "acquisition email not enabled for this workspace" });
      }
      const signature = req.headers["x-esp-signature"];
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
      // The ESP webhook secret lives in the #192 vault under the configured ESP service key.
      const secrets = await resolveServiceSecrets(wid, c.espProvider);
      const secret = secrets.ESP_WEBHOOK_SECRET ?? "";
      try {
        verifyEspSignature(rawBody, typeof signature === "string" ? signature : undefined, secret);
      } catch (err) {
        if (err instanceof EspWebhookVerificationError) {
          req.log.warn({ provider: c.espProvider, workspaceId: wid, reason: err.message }, "webhook signature verification failed");
          recordWebhookSignatureFailure(c.espProvider, err.message);
          return reply.code(400).send({ error: "invalid signature" });
        }
        throw err;
      }
      const suppressions = decideEspSuppressions(parseEspBody(rawBody));
      for (const s of suppressions) {
        await addSuppression({
          workspaceId: wid,
          recipient: s.recipient,
          reason: s.reason,
          source: s.source,
        });
      }
      return reply.code(200).send({ received: true, suppressed: suppressions.length });
    });

    webhookScope.post("/acquisition/esp/inbound/:wid", async (req, reply) => {
      const { wid } = req.params as { wid: string };
      const c = caps(wid);
      if (!c.enabled || !c.channels.email) {
        return reply.code(409).send({ error: "acquisition email not enabled for this workspace" });
      }
      const signature = req.headers["x-esp-signature"];
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
      const secrets = await resolveServiceSecrets(wid, c.espProvider);
      const secret = secrets.ESP_WEBHOOK_SECRET ?? "";
      try {
        verifyEspSignature(rawBody, typeof signature === "string" ? signature : undefined, secret);
      } catch (err) {
        if (err instanceof EspWebhookVerificationError) {
          return reply.code(400).send({ error: "invalid signature" });
        }
        throw err;
      }
      const events = parseEspBody(rawBody);
      const inbound = Array.isArray(events) ? parseInboundEmailReply(events[0]) : null;
      if (!inbound) return reply.code(202).send({ received: true, matched: false });

      const outreach = opts.outreach
        ? await opts.outreach.recordInboundReply(wid, {
            externalRef: inbound.externalRef,
            messageId: inbound.outreachMessageId,
            recipientRef: inbound.outreachRecipientRef,
            replyBody: inbound.body,
            replyFrom: inbound.from,
            replySubject: inbound.subject,
            occurredAt: inbound.occurredAt ?? undefined,
          })
        : { matched: false, created: false };
      if (outreach.matched) {
        return reply.code(outreach.created ? 201 : 200).send({
          received: true,
          matched: true,
          source: "outreach",
          created: outreach.created,
          messageId: outreach.messageId,
        });
      }

      const reach = opts.reach
        ? await opts.reach.recordInboundReply(wid, {
            externalRef: inbound.externalRef,
            inReplyTo: inbound.inReplyTo,
            contactKey: inbound.reachContactKey,
            replyBody: inbound.body,
            replyFrom: inbound.from,
            replySubject: inbound.subject,
            occurredAt: inbound.occurredAt ?? undefined,
          })
        : { matched: false, recorded: false };
      return reply.code(reach.matched && reach.recorded ? 201 : 200).send({
        received: true,
        matched: reach.matched,
        source: reach.matched ? "reach" : null,
        created: reach.recorded,
        contactKey: reach.contactKey,
      });
    });

    // The RFC 8058 one-click unsubscribe receiver (#268). The mailbox provider POSTs the `List-Unsubscribe`
    // URL on the recipient's behalf with body `List-Unsubscribe=One-Click`; the recipient + HMAC token ride
    // the query string (`?e=<recipient>&u=<token>`). Unauthenticated (it is invoked by a mail client, not a
    // logged-in user) but UNFORGEABLE: the token must verify for that recipient — so only links we actually
    // issued work. A verified click adds an `unsubscribe` suppression (reused #189 list). The one-click POST
    // carries a urlencoded body, hence this scope's buffer passthrough parser.
    webhookScope.post("/email/unsubscribe/:wid", async (req, reply) => {
      const { wid } = req.params as { wid: string };
      const q = (req.query ?? {}) as { e?: string; u?: string };
      // The unsubscribe HMAC secret lives in the #192 vault under the configured ESP service key.
      const secrets = await resolveServiceSecrets(wid, caps(wid).espProvider);
      const secret = secrets.EMAIL_UNSUBSCRIBE_SECRET ?? "";
      const decision = decideOneClickUnsubscribe({
        recipient: typeof q.e === "string" ? q.e : "",
        token: typeof q.u === "string" ? q.u : "",
        secret,
      });
      if (!decision.ok || !decision.recipient) {
        return reply.code(400).send({ error: "invalid unsubscribe link" });
      }
      await addSuppression({
        workspaceId: wid,
        recipient: decision.recipient,
        reason: "unsubscribe",
        source: "one-click",
      });
      return reply.code(200).send({ unsubscribed: true });
    });
  });
}
