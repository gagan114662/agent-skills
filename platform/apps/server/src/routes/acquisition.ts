import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { resolveAcquisitionCaps } from "../acquisition/caps.js";
import {
  EspWebhookVerificationError,
  verifyEspSignature,
  parseEspBody,
  decideEspSuppressions,
} from "../acquisition/webhook.js";
import {
  addSuppression,
  listSuppressions,
} from "../db/repositories/acquisition.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { SUPPRESSION_REASONS, type SuppressionReason } from "../acquisition/compliance.js";

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
export async function acquisitionRoutes(app: FastifyInstance): Promise<void> {
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
  });
}
