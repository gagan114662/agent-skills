import { productUrl } from "../product-origins.js";

export interface TelegramConfig {
  botToken?: string;
  roomChatId?: string;
  webhookSecret?: string;
  apiBaseUrl: string;
  maxChars: number;
}

export interface TelegramSendInput {
  chatId: string;
  text: string;
}

export type TelegramSendResult =
  | { status: "sent"; chatId: string; providerMessageId: string }
  | { status: "not_configured"; error: string }
  | { status: "too_long"; error: string }
  | { status: "failed"; error: string };

export interface TelegramTransport {
  sendMessage(input: { botToken: string; apiBaseUrl: string; chatId: string; text: string }): Promise<{
    ok: boolean;
    messageId?: string;
    error?: string;
  }>;
}

export class FetchTelegramTransport implements TelegramTransport {
  async sendMessage(input: { botToken: string; apiBaseUrl: string; chatId: string; text: string }): Promise<{
    ok: boolean;
    messageId?: string;
    error?: string;
  }> {
    const base = input.apiBaseUrl.replace(/\/+$/, "");
    const res = await fetch(base + "/bot" + encodeURIComponent(input.botToken) + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        disable_web_page_preview: true,
      }),
    });
    const payload = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: { message_id?: number }; description?: string }
      | null;
    if (!res.ok || payload?.ok !== true) {
      return { ok: false, error: payload?.description ?? "Telegram send failed" };
    }
    return { ok: true, messageId: String(payload.result?.message_id ?? "") };
  }
}

export class TelegramRoomService {
  constructor(
    private readonly config: TelegramConfig,
    private readonly transport: TelegramTransport = new FetchTelegramTransport(),
  ) {}

  configured(): boolean {
    return Boolean(this.config.botToken && this.config.webhookSecret);
  }

  webhookSecret(): string | undefined {
    return this.config.webhookSecret;
  }

  status(): { configured: boolean; missingEnv: string[] } {
    const missingEnv: string[] = [];
    if (!this.config.botToken) missingEnv.push("TELEGRAM_BOT_TOKEN");
    if (!this.config.webhookSecret) missingEnv.push("TELEGRAM_WEBHOOK_SECRET");
    return { configured: missingEnv.length === 0, missingEnv };
  }

  async send(input: TelegramSendInput): Promise<TelegramSendResult> {
    const token = this.config.botToken;
    if (!token || !this.config.webhookSecret) {
      return { status: "not_configured", error: "Telegram bot token and webhook secret are required" };
    }
    if (input.text.length > this.config.maxChars) {
      return { status: "too_long", error: "Telegram message exceeds " + this.config.maxChars + " characters" };
    }
    try {
      const sent = await this.transport.sendMessage({
        botToken: token,
        apiBaseUrl: this.config.apiBaseUrl,
        chatId: input.chatId,
        text: input.text,
      });
      if (!sent.ok || !sent.messageId) return { status: "failed", error: sent.error ?? "Telegram send failed" };
      return { status: "sent", chatId: input.chatId, providerMessageId: sent.messageId };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : "Telegram send failed" };
    }
  }
}

export function telegramRoomReceipt(input: {
  workspaceId: string;
  channelId: string;
  messageId: string;
  author: string;
  text: string;
}): string {
  return chatNativeRoomUpdate({
    providerPrefix: "tg",
    channelId: input.channelId,
    messageId: input.messageId,
    author: input.author,
    text: input.text,
  });
}

export function parseTelegramRoomReceipt(raw: unknown): { channelId: string; messageId: string } | null {
  if (typeof raw !== "string") return null;
  const match = /(?:^|\s)(?:(?:receipt|ref):\s*)?(?:telegram|tg):([^:\s]+):([^:\s]+)/i.exec(raw.trim());
  if (!match) return null;
  return { channelId: match[1]!, messageId: match[2]! };
}

function chatNativeRoomUpdate(input: {
  providerPrefix: "tg";
  channelId: string;
  messageId: string;
  author: string;
  text: string;
}): string {
  const update = clipped(input.text, 700);
  const lines = [input.author + ": " + update.text];
  if (update.clipped) lines.push("Full update: " + productUrl("/everyday"));
  lines.push("", "reply with ref: " + input.providerPrefix + ":" + input.channelId + ":" + input.messageId);
  return lines.join("\n");
}

function clipped(text: string, max: number): { text: string; clipped: boolean } {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length <= max) return { text: value, clipped: false };
  return { text: value.slice(0, max - 3).trimEnd() + "...", clipped: true };
}
