import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireChannelCapability } from "../auth/access.js";
import { requireIdentity } from "../auth/guard.js";
import { getChannel } from "../db/repositories/channels.js";
import { getServiceCredentialActor, resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { getMessage, postMessage } from "../db/repositories/messages.js";
import { WHATSAPP_ROOM_CONNECTION_ID } from "../connections/registry.js";
import { deliverPostedMessage, deliverThreadReply } from "../messaging/delivery.js";
import { parseVisibilityChannelCommand } from "../messaging/visibility-commands.js";
import { decideRoomApprovalCommand } from "../messaging/room-approval-decisions.js";
import {
  parseWhatsAppRoomReceipt,
  whatsappRoomReceipt,
  type WhatsAppRoomService,
  type WhatsAppSendResult,
} from "../whatsapp/service.js";

export interface WhatsAppRoutesOptions {
  service: WhatsAppRoomService;
}

const WHATSAPP_RECIPIENT_KEY = "WHATSAPP_RECIPIENT";

function statusCode(result: WhatsAppSendResult): number {
  if (result.status === "not_configured") return 503;
  if (result.status === "too_long" || result.status === "failed") return 400;
  return 200;
}

function normalizePhone(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[ +().-]/g, "").trim();
  if (!/^[0-9]{7,18}$/.test(value)) return null;
  return value;
}

function findReceipt(text: string): string | null {
  const match = /(?:^|\s)receipt:\s*(whatsapp:[^\s]+)/i.exec(text);
  return match?.[1] ?? null;
}

function extractInboundMessage(body: unknown): { from: string; text: string; receipt: string | null } | null {
  const payload = body as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: Array<{
            from?: unknown;
            text?: { body?: unknown };
            button?: { text?: unknown };
          }>;
        };
      }>;
    }>;
  };
  const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const from = normalizePhone(message?.from);
  const textRaw = message?.text?.body ?? message?.button?.text;
  const text = typeof textRaw === "string" ? textRaw.trim() : "";
  const receipt = findReceipt(text);
  if (!from || !text) return null;
  return { from, text, receipt };
}

function rawJsonBody(req: FastifyRequest): string {
  return Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
}

function parseRawJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function whatsappRoutes(app: FastifyInstance, opts: WhatsAppRoutesOptions): Promise<void> {
  app.get("/whatsapp/webhook", async (req, reply) => {
    const query = (req.query ?? {}) as {
      "hub.mode"?: unknown;
      "hub.verify_token"?: unknown;
      "hub.challenge"?: unknown;
    };
    if (
      query["hub.mode"] === "subscribe" &&
      typeof query["hub.verify_token"] === "string" &&
      query["hub.verify_token"] === opts.service.verifyToken() &&
      typeof query["hub.challenge"] === "string"
    ) {
      return reply.type("text/plain").send(query["hub.challenge"]);
    }
    return reply.code(403).send({ error: "invalid WhatsApp webhook challenge" });
  });

  app.post("/channels/:cid/whatsapp/room", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid } = req.params as { cid: string };
    const channel = await requireChannelCapability(identity, cid, "write", reply);
    if (!channel) return;
    if (channel.isArchived) return reply.code(404).send({ error: "channel not found" });

    const secrets = await resolveServiceSecrets(identity.workspaceId, WHATSAPP_ROOM_CONNECTION_ID);
    const recipient = normalizePhone(secrets[WHATSAPP_RECIPIENT_KEY]);
    if (!recipient) {
      return reply.code(503).send({
        status: "not_configured",
        error: "Connect WhatsApp room before sending room events to WhatsApp.",
      });
    }

    const body = (req.body ?? {}) as { text?: unknown };
    const text =
      typeof body.text === "string" && body.text.trim()
        ? body.text.trim()
        : "show the ipop team room in WhatsApp.";
    const message = await postMessage({
      workspaceId: identity.workspaceId,
      channelId: cid,
      authorMemberId: identity.memberId,
      body: text,
    });
    await deliverPostedMessage(req.log, identity, channel, message);
    const receipt = "whatsapp:" + cid + ":" + message.id;
    const result = await opts.service.send({
      recipient,
      text: whatsappRoomReceipt({
        workspaceId: identity.workspaceId,
        channelId: cid,
        messageId: message.id,
        author: identity.displayName,
        text,
      }),
    });
    return reply.code(statusCode(result)).send({ ...result, receipt, message });
  });

  await app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );

    webhookScope.post("/whatsapp/webhook", async (req, reply) => {
      const signature = req.headers["x-hub-signature-256"];
      const presented = Array.isArray(signature) ? signature[0] : signature;
      const rawBody = rawJsonBody(req);
      if (!opts.service.verifySignature(rawBody, presented)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const inbound = extractInboundMessage(parseRawJsonBody(rawBody));
      if (!inbound || !inbound.receipt) {
        return reply.code(400).send({ error: "WhatsApp message, sender, and room receipt are required" });
      }
      const receipt = parseWhatsAppRoomReceipt(inbound.receipt);
      if (!receipt) return reply.code(400).send({ error: "invalid WhatsApp room receipt" });

      const original = await getMessage(receipt.messageId);
      if (!original || original.channelId !== receipt.channelId) {
        return reply.code(404).send({ error: "WhatsApp room receipt not found" });
      }
      const channel = await getChannel(receipt.channelId);
      if (!channel || channel.isArchived) {
        return reply.code(404).send({ error: "WhatsApp room channel not found" });
      }
      const secrets = await resolveServiceSecrets(channel.workspaceId, WHATSAPP_ROOM_CONNECTION_ID);
      const expected = normalizePhone(secrets[WHATSAPP_RECIPIENT_KEY]);
      if (!expected || expected !== inbound.from) {
        return reply.code(403).send({ error: "WhatsApp sender is not connected to this workspace" });
      }

      const message = await postMessage({
        workspaceId: channel.workspaceId,
        channelId: receipt.channelId,
        authorMemberId: original.authorMemberId,
        parentMessageId: receipt.messageId,
        alsoSentToChannel: true,
        body: inbound.text,
      });
      await deliverThreadReply(
        req.log,
        {
          workspaceId: channel.workspaceId,
          memberId: original.authorMemberId,
          kind: "human",
          displayName: "WhatsApp",
        },
        channel,
        message,
        original.authorMemberId,
      );
      const command = parseVisibilityChannelCommand(inbound.text);
      const actor = await getServiceCredentialActor(channel.workspaceId, WHATSAPP_ROOM_CONNECTION_ID);
      const approvalDecision = await decideRoomApprovalCommand({
        workspaceId: channel.workspaceId,
        deciderMemberId: actor?.connectedByMemberId ?? null,
        command,
        provider: "whatsapp",
        log: req.log,
      });
      return reply.code(201).send({
        status: "ingested",
        receipt: inbound.receipt,
        message,
        command,
        approvalDecision,
      });
    });
  });
}
