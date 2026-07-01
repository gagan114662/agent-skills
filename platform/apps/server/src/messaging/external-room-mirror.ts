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
const DEBUG_TOOL_CHATTER_ENV = "EXTERNAL_ROOM_DEBUG_TOOL_CHATTER";
const TOOL_MARKER = "\u{1f527}";
const MIRROR_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const recentExternalRoomMirrorKeys = new Map<string, number>();

function envFlag(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

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

function isLocalPathMarkdownLink(line: string): boolean {
  return /\[[^\]]+\]\(\/(?:home|tmp|private|Users|app)\/[^)]*\)/.test(line);
}

function isOperationalMirrorLine(line: string): boolean {
  const value = line.trim();
  if (!value) return false;
  if (/^🤖\s*session\s+[0-9a-f-]+\s+started:/i.test(value)) return true;
  if (/^reading additional input from stdin\.{0,3}$/i.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+(?:ERROR|WARN|INFO)\s+codex_/i.test(value)) {
    return true;
  }
  if (/\bshell snapshot validation failed\b/i.test(value)) return true;
  if (/\bfailed to install system skills\b/i.test(value)) return true;
  if (/\/home\/reload\/\.codex\/shell_snapshots\//i.test(value)) return true;
  if (/^✅\s*session completed\s*\(exit\s+\d+\)/i.test(value)) return true;
  if (/^session completed\s*\(exit\s+\d+\)/i.test(value)) return true;
  if (/^receipt left:\s*/i.test(value)) return true;
  if (/\bsaved in\s+\[[^\]]+\]\(\/(?:home|tmp|private|Users|app)\//i.test(value)) return true;
  if (/^i[’']ve left\b.*\breceipt\b.*\.md\b/i.test(value)) return true;
  if (/^`?(?:curl|python3?|node|pnpm|git|gh)`?\s+(?:is|was)\s+not\s+installed\b/i.test(value)) return true;
  if (/\bbrowser-backed checks\b/i.test(value)) return true;
  if (/\bfinal source check\b/i.test(value)) return true;
  if (/\boutbound answer\b/i.test(value) && /\bverified\b/i.test(value)) return true;
  return false;
}

function isOperationalMirrorBody(body: string): boolean {
  const value = body.trim();
  if (!value) return false;
  if (/^🤖\s*session\s+[0-9a-f-]+\s+started:/i.test(value)) return true;
  if (/^reading additional input from stdin\.{0,3}$/i.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+(?:ERROR|WARN|INFO)\s+codex_/i.test(value)) {
    return true;
  }
  return false;
}

function isCustomerValuableAgentBody(body: string): boolean {
  const value = body.replace(/\s+/g, " ").trim();
  if (!value) return false;
  return /\b(preview|deliverable|approval request|pending approval|blocked|handoff)\b/i.test(value);
}

function isLowValueAgentProgressBody(body: string): boolean {
  if (isCustomerValuableAgentBody(body)) return false;
  const value = body.replace(/\s+/g, " ").trim();
  if (!value) return true;
  if (
    /^(?:and\s+)?(?:i['’]?ll|i will)\b/i.test(value) &&
    /\b(?:write|draft|make|read|inspect|check|look|handle|treat|use|leave|avoid|keep|start|work)\b/i.test(value)
  ) {
    return true;
  }
  if (/^(?:drafting|writing|making|checking|reading|inspecting|looking|handling|working|ready to)\b/i.test(value)) {
    return true;
  }
  if (/^(?:right,?\s*)?i\s+(?:read|checked|looked at)\b.*\bfound something\b/i.test(value)) return true;
  if (/\b(?:found something|the good ones|tastefully loud)\b/i.test(value)) return true;
  if (/\b(?:empty workspace|workspace looks empty|local note|receipt file|room\/brief artifacts|source of truth and checking|execution-only actions behind approval)\b/i.test(value)) {
    return true;
  }
  return false;
}

function stripOperationalMirrorLines(body: string): string {
  if (isOperationalMirrorBody(body)) return "";
  return body
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !isOperationalMirrorLine(line))
    .filter((line) => !(isLocalPathMarkdownLink(line) && !/^\s*\d+[.)]/.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isToolTraceLine(line: string): boolean {
  const value = line.trim();
  if (!value) return false;
  if (/^```/.test(value)) return true;
  if (/^(script completed|script failed|wall time|exit code|output:|stderr:|stdout:|workdir:|command:)/i.test(value)) {
    return true;
  }
  if (/^(\$|>|%|❯)\s*(pnpm|npm|node|tsx|gh|git|curl|python3?|sed|rg|cat|ls|jq|psql|docker)\b/i.test(value)) {
    return true;
  }
  if (/^(pnpm|npm|node|tsx|gh|git|curl|python3?|sed|rg|cat|ls|jq|psql|docker)\s+[-\w./:@]/i.test(value)) {
    return true;
  }
  if (/^(await tools\.|const result = await tools\.|tools\.|import\(|JSON\.stringify\()/i.test(value)) return true;
  if (/^(\{|\[).*("cmd"|"workdir"|"yield_time_ms"|"max_output_tokens")/i.test(value)) return true;
  return false;
}

function customerSafeBody(input: { body: string; type: ExternalRoomEventType }): string {
  const body = stripOperationalMirrorLines(input.body) || input.body;
  const lines = body.split(/\r?\n/);
  const traceLines = lines.filter(isToolTraceLine).length;
  const nonTraceLines = lines
    .map((line) => line.trim())
    .filter((line) => line && !isToolTraceLine(line) && !/^[-=]{3,}$/.test(line));
  const traceHeavy = traceLines > 0 && traceLines >= Math.max(2, Math.ceil(lines.filter((line) => line.trim()).length / 3));
  if (!traceHeavy) return body;

  const safe = nonTraceLines
    .filter((line) => !/[{};]/.test(line) || /[.!?]$/.test(line))
    .join(" ");
  if (safe.trim()) return safe;

  if (input.type === "blocked") return "blocked: ran into a technical blocker. Ask for debug details if you want the full trace.";
  if (input.type === "approval_request") return "approval request ready. Ask for debug details if you want the full trace.";
  if (input.type === "deliverable_preview") return "preview ready. Ask for debug details if you want the full trace.";
  return "working update: technical work is underway. Ask for debug details if you want the full trace.";
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
          : "";
    return {
      type,
      text: label ? label + ": " + snippet(teamEvent.summary, 500) : snippet(teamEvent.summary, 500),
    };
  }

  const type = classifyExternalRoomEvent(input);
  const body = snippet(customerSafeBody({ body: input.body, type }), 700);
  if (type === "approval_request") {
    return {
      type,
      text:
        labelExternalRoomBody("approval request", body) +
        "\nReply YES approval <id> because ... or NO approval <id> because ...",
    };
  }
  const labels: Record<ExternalRoomEventType, string | null> = {
    room_message: null,
    thread_reply: "reply",
    agent_status: null,
    handoff: "handoff",
    approval_request: "approval request",
    deliverable_preview: "preview",
    blocked: "blocked",
  };
  const label = labels[type];
  return { type, text: label ? labelExternalRoomBody(label, body) : body };
}

function labelExternalRoomBody(label: string, body: string): string {
  const value = body.trim();
  return value.toLowerCase().startsWith(label.toLowerCase() + ":") ? value : label + ": " + value;
}

export function isExternalRoomDebugChatter(input: {
  body: string;
  source: ExternalRoomMirrorSource;
}): boolean {
  if (input.source !== "agent_post") return false;
  const teamEvent = tryParseTeamEvent(input.body);
  if (teamEvent?.kind === "started") return true;
  if (teamEvent?.kind === "milestone" && !isCustomerValuableAgentBody(teamEvent.summary)) return true;
  if (isOperationalMirrorBody(input.body)) return true;

  const contentLines = input.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (contentLines.length > 0 && contentLines.every(isOperationalMirrorLine)) return true;

  const stripped = stripOperationalMirrorLines(input.body);
  if (!stripped && contentLines.length > 0) return true;

  const body = (stripped || input.body).replace(/\s+/g, " ").trim();
  if (!body) return true;
  if (isLowValueAgentProgressBody(body)) return true;
  if (body.startsWith(TOOL_MARKER)) return true;
  if (/^(?:tool(?: call| use| result)?|command_execution|file_change)\b[:\s-]*/i.test(body)) return true;
  if (/(?:^|\s)\/bin\/(?:sh|bash)\s+-lc\b/.test(body)) return true;
  if (
    /^\{/.test(body) &&
    /"(?:tool_use|tool_result|command_execution|file_change|item\.completed)"/.test(body)
  ) {
    return true;
  }
  return false;
}

function rememberExternalRoomMirrorSend(input: {
  provider: ExternalRoomMessageProvider;
  conversationId: string;
  channelId: string;
  eventText: string;
  nowMs?: number;
}): { key: string; duplicate: boolean } {
  const nowMs = input.nowMs ?? Date.now();
  for (const [key, seenAt] of recentExternalRoomMirrorKeys) {
    if (nowMs - seenAt > MIRROR_DEDUPE_WINDOW_MS) recentExternalRoomMirrorKeys.delete(key);
  }
  const key = [input.provider, input.conversationId, input.channelId, snippet(input.eventText, 700)].join("\u0000");
  const seenAt = recentExternalRoomMirrorKeys.get(key);
  if (seenAt !== undefined && nowMs - seenAt <= MIRROR_DEDUPE_WINDOW_MS) return { key, duplicate: true };
  recentExternalRoomMirrorKeys.set(key, nowMs);
  return { key, duplicate: false };
}

export function shouldMirrorExternalRoomEvent(input: {
  body: string;
  source: ExternalRoomMirrorSource;
}): boolean {
  if (envFlag(process.env[DEBUG_TOOL_CHATTER_ENV])) return true;
  return !isExternalRoomDebugChatter(input);
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
    const dedupe = rememberExternalRoomMirrorSend({
      provider: destination.provider,
      conversationId: destination.conversationId,
      channelId: input.channelId,
      eventText,
    });
    if (dedupe.duplicate) return;

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
        recentExternalRoomMirrorKeys.delete(dedupe.key);
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
      recentExternalRoomMirrorKeys.delete(dedupe.key);
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
      if (!shouldMirrorExternalRoomEvent({ body: input.message.body, source: input.source })) return;
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
