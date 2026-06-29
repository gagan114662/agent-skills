import type { FastifyBaseLogger } from "fastify";
import { TELEGRAM_ROOM_CONNECTION_ID, WHATSAPP_ROOM_CONNECTION_ID } from "../connections/registry.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import {
  getExternalRoomMessageReceiptForMessage,
  recordExternalRoomMessageReceipt,
  type ExternalRoomMessageProvider,
} from "../db/repositories/external-room-message-receipts.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import type { Message } from "../db/repositories/messages.js";
import { telegramRoomReceipt, type TelegramRoomService } from "../telegram/service.js";
import { tryParseTeamEvent } from "../team/protocol.js";
import { whatsappRoomReceipt, type WhatsAppRoomService } from "../whatsapp/service.js";

export type ExternalRoomMirrorSource = "room_message" | "thread_reply" | "agent_post";

export type ExternalRoomEventType =
  | "room_message"
  | "thread_reply"
  | "agent_status"
  | "handoff"
  | "approval_request"
  | "deliverable_preview"
  | "blocked";

export interface ExternalRoomMirrorInput {
  workspaceId: string;
  channelId: string;
  message: Message;
  author?: string;
  source: ExternalRoomMirrorSource;
}

export interface ExternalRoomMirror {
  mirror(input: ExternalRoomMirrorInput): Promise<void>;
}

interface MirrorLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

interface ExternalRoomMirrorDeps {
  telegram: Pick<TelegramRoomService, "send">;
  whatsapp: Pick<WhatsAppRoomService, "send">;
  log?: MirrorLogger;
  resolveSecrets?: typeof resolveServiceSecrets;
  getReceiptForMessage?: typeof getExternalRoomMessageReceiptForMessage;
  recordReceipt?: typeof recordExternalRoomMessageReceipt;
  getMember?: typeof getWorkspaceMember;
}

interface ProviderDestination {
  provider: ExternalRoomMessageProvider;
  conversationId: string;
}

const TELEGRAM_CHAT_ID_KEY = "TELEGRAM_CHAT_ID";
const WHATSAPP_RECIPIENT_KEY = "WHATSAPP_RECIPIENT";

function normalizeTelegramChatId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!/^-?[0-9]{3,32}$/.test(value)) return null;
  return value;
}

function normalizeWhatsAppRecipient(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[ +().-]/g, "").trim();
  if (!/^[0-9]{7,18}$/.test(value)) return null;
  return value;
}

function snippet(text: string, max = 1200): string {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 3).trimEnd() + "...";
}

export function classifyExternalRoomEvent(input: {
  body: string;
  source: ExternalRoomMirrorSource;
}): ExternalRoomEventType {
  const teamEvent = tryParseTeamEvent(input.body);
  if (teamEvent) {
    if (teamEvent.kind === "blocked") return "blocked";
    if (teamEvent.kind === "needs_handoff") return "handoff";
    return "agent_status";
  }
  const body = input.body.toLowerCase();
  if (body.includes("blocked before") || body.startsWith("blocked:")) return "blocked";
  if (body.includes("approval request") || body.includes("pending approval")) return "approval_request";
  if (body.includes("handoff")) return "handoff";
  if (body.includes("deliverable") || body.includes("preview")) return "deliverable_preview";
  if (input.source === "thread_reply") return "thread_reply";
  if (input.source === "agent_post") return "agent_status";
  return "room_message";
}

export function formatExternalRoomEvent(input: {
  body: string;
  source: ExternalRoomMirrorSource;
}): { type: ExternalRoomEventType; text: string } {
  const teamEvent = tryParseTeamEvent(input.body);
  if (teamEvent) {
    const type = classifyExternalRoomEvent(input);
    const label =
      type === "handoff"
        ? "handoff"
        : type === "blocked"
          ? "blocked"
          : "agent update";
    const lines = [
      label + ": " + snippet(teamEvent.summary),
      "team run: " + teamEvent.teamRunId,
      "subtask: " + teamEvent.subtaskId,
    ];
    if (teamEvent.branch) lines.push("branch: " + teamEvent.branch);
    return { type, text: lines.join("\n") };
  }

  const type = classifyExternalRoomEvent(input);
  const labels: Record<ExternalRoomEventType, string> = {
    room_message: "room message",
    thread_reply: "thread reply",
    agent_status: "agent update",
    handoff: "handoff",
    approval_request: "approval request",
    deliverable_preview: "deliverable preview",
    blocked: "blocked",
  };
  return { type, text: labels[type] + ": " + snippet(input.body) };
}

function logRetryableFailure(input: {
  log?: MirrorLogger;
  provider: ExternalRoomMessageProvider;
  workspaceId: string;
  channelId: string;
  messageId: string;
  status: string;
  error: string;
}): void {
  input.log?.warn(
    {
      provider: input.provider,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      messageId: input.messageId,
      status: input.status,
      error: input.error,
      retryable: true,
    },
    "external room mirror failed",
  );
}

async function safeAuthor(input: {
  workspaceId: string;
  message: Message;
  author?: string;
  getMember: typeof getWorkspaceMember;
}): Promise<string> {
  if (input.author?.trim()) return input.author.trim();
  const member = await input.getMember(input.message.authorMemberId, input.workspaceId);
  return member?.displayName ?? "ipop";
}

export function createExternalRoomMirror(deps: ExternalRoomMirrorDeps): ExternalRoomMirror {
  const resolveSecrets = deps.resolveSecrets ?? resolveServiceSecrets;
  const getReceiptForMessage = deps.getReceiptForMessage ?? getExternalRoomMessageReceiptForMessage;
  const recordReceipt = deps.recordReceipt ?? recordExternalRoomMessageReceipt;
  const getMember = deps.getMember ?? getWorkspaceMember;

  async function destinations(workspaceId: string): Promise<ProviderDestination[]> {
    const out: ProviderDestination[] = [];
    const telegramSecrets = await resolveSecrets(workspaceId, TELEGRAM_ROOM_CONNECTION_ID);
    const chatId = normalizeTelegramChatId(telegramSecrets[TELEGRAM_CHAT_ID_KEY]);
    if (chatId) out.push({ provider: "telegram", conversationId: chatId });
    const whatsappSecrets = await resolveSecrets(workspaceId, WHATSAPP_ROOM_CONNECTION_ID);
    const recipient = normalizeWhatsAppRecipient(whatsappSecrets[WHATSAPP_RECIPIENT_KEY]);
    if (recipient) out.push({ provider: "whatsapp", conversationId: recipient });
    return out;
  }

  async function mirrorOne(
    input: ExternalRoomMirrorInput,
    destination: ProviderDestination,
    author: string,
    eventText: string,
  ): Promise<void> {
    const existing = await getReceiptForMessage({
      provider: destination.provider,
      providerConversationId: destination.conversationId,
      messageId: input.message.id,
    });
    if (existing) return;

    if (destination.provider === "telegram") {
      const result = await deps.telegram.send({
        chatId: destination.conversationId,
        text: telegramRoomReceipt({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          messageId: input.message.id,
          author,
          text: eventText,
        }),
      });
      if (result.status !== "sent") {
        logRetryableFailure({
          log: deps.log,
          provider: "telegram",
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          messageId: input.message.id,
          status: result.status,
          error: result.error,
        });
        return;
      }
      await recordReceipt({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: input.message.id,
        provider: "telegram",
        providerConversationId: destination.conversationId,
        providerMessageId: result.providerMessageId,
      });
      return;
    }

    const result = await deps.whatsapp.send({
      recipient: destination.conversationId,
      text: whatsappRoomReceipt({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: input.message.id,
        author,
        text: eventText,
      }),
    });
    if (result.status !== "sent") {
      logRetryableFailure({
        log: deps.log,
        provider: "whatsapp",
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: input.message.id,
        status: result.status,
        error: result.error,
      });
      return;
    }
    await recordReceipt({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      messageId: input.message.id,
      provider: "whatsapp",
      providerConversationId: destination.conversationId,
      providerMessageId: result.providerMessageId,
    });
  }

  return {
    async mirror(input) {
      if (input.message.alsoSentToChannel) return;
      const connected = await destinations(input.workspaceId);
      if (connected.length === 0) return;
      const author = await safeAuthor({ ...input, getMember });
      const event = formatExternalRoomEvent({
        body: input.message.body,
        source: input.source,
      });
      for (const destination of connected) {
        await mirrorOne(input, destination, author, event.text);
      }
    },
  };
}

let externalRoomMirror: ExternalRoomMirror | undefined;

export function setExternalRoomMirror(mirror: ExternalRoomMirror | undefined): void {
  externalRoomMirror = mirror;
}

export async function mirrorExternalRoomPost(
  log: FastifyBaseLogger | undefined,
  input: ExternalRoomMirrorInput,
): Promise<void> {
  if (!externalRoomMirror) return;
  try {
    await externalRoomMirror.mirror(input);
  } catch (err) {
    (log ?? undefined)?.error(
      {
        err,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: input.message.id,
        retryable: true,
      },
      "external room mirror crashed",
    );
  }
}
