import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireChannelCapability } from "../auth/access.js";
import { requireIdentity } from "../auth/guard.js";
import { getChannel } from "../db/repositories/channels.js";
import {
  findServiceCredentialOwnerBySecretValue,
  getServiceCredentialActor,
  resolveServiceSecrets,
  setServiceCredentials,
} from "../db/repositories/external-credentials.js";
import {
  getExternalRoomMessageReceipt,
  recordExternalRoomMessageReceipt,
} from "../db/repositories/external-room-message-receipts.js";
import { getMessage, postMessage } from "../db/repositories/messages.js";
import { TELEGRAM_ROOM_CONNECTION_ID } from "../connections/registry.js";
import { deliverPostedMessage, deliverThreadReply } from "../messaging/delivery.js";
import type { InboundTeamLaunchResult, InboundTeamLaunchService } from "../messaging/inbound-team-launch.js";
import { parseVisibilityChannelCommand } from "../messaging/visibility-commands.js";
import { decideRoomApprovalCommand } from "../messaging/room-approval-decisions.js";
import {
  parseTelegramRoomReceipt,
  telegramRoomReceipt,
  type TelegramRoomService,
  type TelegramSendResult,
} from "../telegram/service.js";
import { consumeTelegramConnectCode, parseTelegramStartCode } from "../telegram/connect-code.js";
import { productUrl } from "../product-origins.js";

export interface TelegramRoutesOptions {
  service: TelegramRoomService;
  inboundTeamLaunch?: InboundTeamLaunchService;
}

const TELEGRAM_CHAT_ID_KEY = "TELEGRAM_CHAT_ID";

function telegramConnectReply(status: "connected" | "already_connected_elsewhere" | "expired"): string {
  if (status === "connected") {
    return [
      "Telegram is connected to your ipop marketing room.",
      "Send a target here and Scout, Quill, Echo, and Bid will start in the same room.",
      'Try: "market ipop.ai to SaaS founders" or "turn tomo.ai into a sharper launch plan".',
      "Useful drafts, approval requests, and receipts will mirror back here.",
    ].join("\n");
  }
  if (status === "already_connected_elsewhere") {
    return "This Telegram chat is already connected to another ipop workspace. Disconnect it there before reconnecting.";
  }
  return "That Telegram connect link expired. Open " + productUrl("/everyday") + ", tap Connect Telegram, then press Start again.";
}

function statusCode(result: TelegramSendResult): number {
  if (result.status === "not_configured") return 503;
  if (result.status === "too_long" || result.status === "failed") return 400;
  return 200;
}

function launchStatusCode(result: InboundTeamLaunchResult): number {
  return result.status === "duplicate" ? 200 : 202;
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

function normalizeProviderMessageId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value ? value : null;
}

function extractTelegramMessage(
  body: unknown,
): {
  chatId: string;
  text: string;
  receipt: string | null;
  providerMessageId: string | null;
  providerReplyToMessageId: string | null;
} | null {
  const update = body as {
    message?: {
      message_id?: unknown;
      chat?: { id?: unknown };
      text?: unknown;
      reply_to_message?: { message_id?: unknown; text?: unknown };
    };
  };
  const chatId = normalizeChatId(update?.message?.chat?.id);
  const text = typeof update?.message?.text === "string" ? update.message.text.trim() : "";
  const replyText = typeof update?.message?.reply_to_message?.text === "string" ? update.message.reply_to_message.text : "";
  const receipt = findReceipt(replyText) ?? findReceipt(text);
  const providerMessageId = normalizeProviderMessageId(update?.message?.message_id);
  const providerReplyToMessageId = normalizeProviderMessageId(update?.message?.reply_to_message?.message_id);
  if (!chatId || !text) return null;
  return { chatId, text, receipt, providerMessageId, providerReplyToMessageId };
}

function findReceipt(text: string): string | null {
  const match = /(?:^|\s)(?:receipt|ref):\s*((?:telegram|tg):[^\s]+)/i.exec(text);
  return match?.[1] ?? null;
}

async function bindTelegramStartCode(input: {
  chatId: string;
  text: string;
}): Promise<
  | { status: "not_start_code" }
  | { status: "expired" }
  | { status: "already_connected_elsewhere"; workspaceId: string }
  | { status: "connected"; workspaceId: string; memberId: string }
> {
  const code = parseTelegramStartCode(input.text);
  if (!code) return { status: "not_start_code" };
  const pending = await consumeTelegramConnectCode(code);
  if (!pending) return { status: "expired" };
  const existing = await findServiceCredentialOwnerBySecretValue({
    serviceKey: TELEGRAM_ROOM_CONNECTION_ID,
    envKey: TELEGRAM_CHAT_ID_KEY,
    value: input.chatId,
  });
  if (existing && existing.workspaceId !== pending.workspaceId) {
    return { status: "already_connected_elsewhere", workspaceId: existing.workspaceId };
  }
  await setServiceCredentials({
    workspaceId: pending.workspaceId,
    serviceKey: TELEGRAM_ROOM_CONNECTION_ID,
    secrets: { [TELEGRAM_CHAT_ID_KEY]: input.chatId },
    scopes: ["room_visibility"],
    connectedByMemberId: pending.memberId,
  });
  return { status: "connected", workspaceId: pending.workspaceId, memberId: pending.memberId };
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
    const deployment = opts.service.status();
    if (!deployment.configured) {
      return reply.code(503).send({
        status: "not_configured",
        error: "Telegram sender and webhook credentials are required before room events can be sent to Telegram.",
        missingEnv: deployment.missingEnv,
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
      alsoSentToChannel: true,
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
    if (result.status === "sent") {
      await recordExternalRoomMessageReceipt({
        workspaceId: identity.workspaceId,
        channelId: cid,
        messageId: message.id,
        provider: "telegram",
        providerConversationId: chatId,
        providerMessageId: result.providerMessageId,
      });
    }
    return reply.code(statusCode(result)).send({
      ...result,
      receipt,
      message,
    });
  });

  app.post("/telegram/webhook", async (req, reply) => {
    if (!requireTelegramSecret(req, reply, opts.service.webhookSecret())) return;
    const inbound = extractTelegramMessage(req.body);
    if (!inbound) {
      return reply.code(400).send({ error: "Telegram message and chat id are required" });
    }
    if (!inbound.receipt && !inbound.providerReplyToMessageId) {
      const bound = await bindTelegramStartCode({ chatId: inbound.chatId, text: inbound.text });
      if (bound.status !== "not_start_code") {
        const text = telegramConnectReply(bound.status);
        const sent = await opts.service.send({ chatId: inbound.chatId, text });
        return reply.code(bound.status === "connected" ? 200 : 409).send({ ...bound, providerReply: sent });
      }
      if (!opts.inboundTeamLaunch) {
        return reply.code(400).send({ error: "Telegram room reply reference is required" });
      }
      const launched = await opts.inboundTeamLaunch.start({
        provider: "telegram",
        serviceKey: TELEGRAM_ROOM_CONNECTION_ID,
        destinationEnvKey: TELEGRAM_CHAT_ID_KEY,
        providerLabel: "Telegram",
        providerConversationId: inbound.chatId,
        providerMessageId: inbound.providerMessageId,
        text: inbound.text,
        log: req.log,
      });
      const sent = await opts.service.send({ chatId: inbound.chatId, text: launched.replyText });
      if (sent.status === "sent" && "workspaceId" in launched) {
        await recordExternalRoomMessageReceipt({
          workspaceId: launched.workspaceId,
          channelId: launched.channelId,
          messageId: launched.messageId,
          provider: "telegram",
          providerConversationId: inbound.chatId,
          providerMessageId: sent.providerMessageId,
        });
      }
      return reply.code(launchStatusCode(launched)).send({ ...launched, providerReply: sent });
    }
    const receipt =
      parseTelegramRoomReceipt(inbound.receipt) ??
      (inbound.providerReplyToMessageId
        ? await getExternalRoomMessageReceipt({
            provider: "telegram",
            providerConversationId: inbound.chatId,
            providerMessageId: inbound.providerReplyToMessageId,
          })
        : null);
    if (!receipt) return reply.code(400).send({ error: "invalid Telegram room reply reference" });

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
    const actor = await getServiceCredentialActor(channel.workspaceId, TELEGRAM_ROOM_CONNECTION_ID);
    const authorMemberId = actor?.connectedByMemberId ?? original.authorMemberId;

    const message = await postMessage({
      workspaceId: channel.workspaceId,
      channelId: receipt.channelId,
      authorMemberId,
      parentMessageId: receipt.messageId,
      alsoSentToChannel: true,
      body: inbound.text,
    });
    if (inbound.providerMessageId) {
      await recordExternalRoomMessageReceipt({
        workspaceId: channel.workspaceId,
        channelId: receipt.channelId,
        messageId: message.id,
        provider: "telegram",
        providerConversationId: inbound.chatId,
        providerMessageId: inbound.providerMessageId,
        direction: "inbound",
      });
    }
    await deliverThreadReply(
      req.log,
      { workspaceId: channel.workspaceId, memberId: authorMemberId, kind: "human", displayName: "Telegram" },
      channel,
      message,
      original.authorMemberId,
    );
    const command = parseVisibilityChannelCommand(inbound.text);
    const approvalDecision = await decideRoomApprovalCommand({
      workspaceId: channel.workspaceId,
      deciderMemberId: actor?.connectedByMemberId ?? null,
      command,
      provider: "telegram",
      log: req.log,
    });
    return reply.code(201).send({
      status: "ingested",
      receipt: inbound.receipt ?? "telegram-provider:" + inbound.providerReplyToMessageId,
      message,
      command,
      approvalDecision,
    });
  });
}
