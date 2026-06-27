import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireChannelCapability } from "../auth/access.js";
import { requireIdentity } from "../auth/guard.js";
import { getChannel } from "../db/repositories/channels.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { getMessage, postMessage } from "../db/repositories/messages.js";
import { TELEGRAM_ROOM_CONNECTION_ID } from "../connections/registry.js";
import { deliverPostedMessage, deliverThreadReply } from "../messaging/delivery.js";
import { parseVisibilityChannelCommand } from "../messaging/visibility-commands.js";
import {
  parseTelegramRoomReceipt,
  telegramRoomReceipt,
  type TelegramRoomService,
  type TelegramSendResult,
} from "../telegram/service.js";

export interface TelegramRoutesOptions {
  service: TelegramRoomService;
}

const TELEGRAM_CHAT_ID_KEY = "TELEGRAM_CHAT_ID";

function statusCode(result: TelegramSendResult): number {
  if (result.status === "not_configured") return 503;
  if (result.status === "too_long" || result.status === "failed") return 400;
  return 200;
}

function requireTelegramSecret(req: FastifyRequest, reply: FastifyReply, secret?: string): boolean {
  if (!secret) {
    reply.code(503).send({ error: "Telegram webhook is not configured" });
    return false;
  }
  const header = req.headers["x-telegram-bot-api-secret-token"];
  const presented = Array.isArray(header) ? header[0] : header;
  if (presented !== secret) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

function normalizeChatId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!/^-?[0-9]{3,32}$/.test(value)) return null;
  return value;
}

function extractTelegramMessage(body: unknown): { chatId: string; text: string; receipt: string | null } | null {
  const update = body as {
    message?: {
      chat?: { id?: unknown };
      text?: unknown;
      reply_to_message?: { text?: unknown };
    };
  };
  const chatId = normalizeChatId(update?.message?.chat?.id);
  const text = typeof update?.message?.text === "string" ? update.message.text.trim() : "";
  const replyText = typeof update?.message?.reply_to_message?.text === "string" ? update.message.reply_to_message.text : "";
  const receipt = findReceipt(replyText) ?? findReceipt(text);
  if (!chatId || !text) return null;
  return { chatId, text, receipt };
}

function findReceipt(text: string): string | null {
  const match = /(?:^|\s)receipt:\s*(telegram:[^\s]+)/i.exec(text);
  return match?.[1] ?? null;
}

export async function telegramRoutes(app: FastifyInstance, opts: TelegramRoutesOptions): Promise<void> {
  app.post("/channels/:cid/telegram/room", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid } = req.params as { cid: string };
    const channel = await requireChannelCapability(identity, cid, "write", reply);
    if (!channel) return;
    if (channel.isArchived) {
      return reply.code(404).send({ error: "channel not found" });
    }
    const secrets = await resolveServiceSecrets(identity.workspaceId, TELEGRAM_ROOM_CONNECTION_ID);
    const chatId = normalizeChatId(secrets[TELEGRAM_CHAT_ID_KEY]);
    if (!chatId) {
      return reply.code(503).send({
        status: "not_configured",
        error: "Connect Telegram room before sending room events to Telegram.",
      });
    }

    const body = (req.body ?? {}) as { text?: unknown };
    const text =
      typeof body.text === "string" && body.text.trim()
        ? body.text.trim()
        : "show the ipop team room in Telegram.";
    const message = await postMessage({
      workspaceId: identity.workspaceId,
      channelId: cid,
      authorMemberId: identity.memberId,
      body: text,
    });
    await deliverPostedMessage(req.log, identity, channel, message);
    const receipt = "telegram:" + cid + ":" + message.id;
    const result = await opts.service.send({
      chatId,
      text: telegramRoomReceipt({
        workspaceId: identity.workspaceId,
        channelId: cid,
        messageId: message.id,
        author: identity.displayName,
        text,
      }),
    });
    return reply.code(statusCode(result)).send({
      ...result,
      receipt,
      message,
    });
  });

  app.post("/telegram/webhook", async (req, reply) => {
    if (!requireTelegramSecret(req, reply, opts.service.webhookSecret())) return;
    const inbound = extractTelegramMessage(req.body);
    if (!inbound || !inbound.receipt) {
      return reply.code(400).send({ error: "Telegram message, chat id, and room receipt are required" });
    }
    const receipt = parseTelegramRoomReceipt(inbound.receipt);
    if (!receipt) return reply.code(400).send({ error: "invalid Telegram room receipt" });

    const original = await getMessage(receipt.messageId);
    if (!original || original.channelId !== receipt.channelId) {
      return reply.code(404).send({ error: "Telegram room receipt not found" });
    }
    const channel = await getChannel(receipt.channelId);
    if (!channel || channel.isArchived) {
      return reply.code(404).send({ error: "Telegram room channel not found" });
    }
    const secrets = await resolveServiceSecrets(channel.workspaceId, TELEGRAM_ROOM_CONNECTION_ID);
    const expectedChatId = normalizeChatId(secrets[TELEGRAM_CHAT_ID_KEY]);
    if (!expectedChatId || expectedChatId !== inbound.chatId) {
      return reply.code(403).send({ error: "Telegram chat is not connected to this workspace" });
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
      { workspaceId: channel.workspaceId, memberId: original.authorMemberId, kind: "human", displayName: "Telegram" },
      channel,
      message,
      original.authorMemberId,
    );
    return reply.code(201).send({
      status: "ingested",
      receipt: inbound.receipt,
      message,
      command: parseVisibilityChannelCommand(inbound.text),
    });
  });
}
