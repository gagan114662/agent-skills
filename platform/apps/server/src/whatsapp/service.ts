import { createHmac, timingSafeEqual } from "node:crypto";

export interface WhatsAppConfig {
  accessToken?: string;
  phoneNumberId?: string;
  roomRecipient?: string;
  webhookVerifyToken?: string;
  appSecret?: string;
  apiBaseUrl: string;
  maxChars: number;
}

export type WhatsAppSendResult =
  | { status: "sent"; recipient: string; providerMessageId: string }
  | { status: "not_configured"; error: string }
  | { status: "too_long"; error: string }
  | { status: "failed"; error: string };

export interface WhatsAppTransport {
  sendMessage(input: {
    accessToken: string;
    apiBaseUrl: string;
    phoneNumberId: string;
    recipient: string;
    text: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }>;
}

export class FetchWhatsAppTransport implements WhatsAppTransport {
  async sendMessage(input: {
    accessToken: string;
    apiBaseUrl: string;
    phoneNumberId: string;
    recipient: string;
    text: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const base = input.apiBaseUrl.replace(/\/+$/, "");
    const res = await fetch(base + "/" + encodeURIComponent(input.phoneNumberId) + "/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer " + input.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.recipient,
        type: "text",
        text: { preview_url: false, body: input.text },
      }),
    });
    const payload = (await res.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }>; error?: { message?: string } }
      | null;
    if (!res.ok) return { ok: false, error: payload?.error?.message ?? "WhatsApp send failed" };
    return { ok: true, messageId: payload?.messages?.[0]?.id ?? "" };
  }
}

export class WhatsAppRoomService {
  constructor(
    private readonly config: WhatsAppConfig,
    private readonly transport: WhatsAppTransport = new FetchWhatsAppTransport(),
  ) {}

  status(): { configured: boolean; missingEnv: string[] } {
    const missingEnv: string[] = [];
    if (!this.config.accessToken) missingEnv.push("WHATSAPP_ACCESS_TOKEN");
    if (!this.config.phoneNumberId) missingEnv.push("WHATSAPP_PHONE_NUMBER_ID");
    if (!this.config.roomRecipient) missingEnv.push("WHATSAPP_ROOM_RECIPIENT");
    if (!this.config.webhookVerifyToken) missingEnv.push("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
    if (!this.config.appSecret) missingEnv.push("WHATSAPP_APP_SECRET");
    return { configured: missingEnv.length === 0, missingEnv };
  }

  verifyToken(): string | undefined {
    return this.config.webhookVerifyToken;
  }

  verifySignature(rawBody: string, signature: string | undefined): boolean {
    const secret = this.config.appSecret;
    if (!secret || !signature?.startsWith("sha256=")) return false;
    const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(signature);
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  }

  async send(input: { recipient: string; text: string }): Promise<WhatsAppSendResult> {
    const token = this.config.accessToken;
    const phoneNumberId = this.config.phoneNumberId;
    if (!token || !phoneNumberId || !this.config.appSecret || !this.config.webhookVerifyToken) {
      return { status: "not_configured", error: "WhatsApp sender and webhook credentials are required" };
    }
    if (input.text.length > this.config.maxChars) {
      return { status: "too_long", error: "WhatsApp message exceeds " + this.config.maxChars + " characters" };
    }
    try {
      const sent = await this.transport.sendMessage({
        accessToken: token,
        apiBaseUrl: this.config.apiBaseUrl,
        phoneNumberId,
        recipient: input.recipient,
        text: input.text,
      });
      if (!sent.ok || !sent.messageId) return { status: "failed", error: sent.error ?? "WhatsApp send failed" };
      return { status: "sent", recipient: input.recipient, providerMessageId: sent.messageId };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : "WhatsApp send failed" };
    }
  }
}

export function whatsappRoomReceipt(input: {
  workspaceId: string;
  channelId: string;
  messageId: string;
  author: string;
  text: string;
}): string {
  return [
    "ipop room update",
    "workspace: " + input.workspaceId,
    "receipt: whatsapp:" + input.channelId + ":" + input.messageId,
    input.author + ": " + input.text,
  ].join("\n");
}

export function parseWhatsAppRoomReceipt(raw: unknown): { channelId: string; messageId: string } | null {
  if (typeof raw !== "string") return null;
  const match = /^whatsapp:([^:]+):([^:]+)$/.exec(raw.trim());
  if (!match) return null;
  return { channelId: match[1]!, messageId: match[2]! };
}

