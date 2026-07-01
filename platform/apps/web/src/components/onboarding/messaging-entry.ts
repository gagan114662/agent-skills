export const TELEGRAM_BOT_URL = "https://t.me/ipopmarketingbot";
export const NATIVE_IMESSAGE_URL = "imessage://";
export const WHATSAPP_URL = "https://wa.me/";

export type MessagingChannelKey = "telegram" | "imessage" | "whatsapp";

export function messagingChannelUrl(channel: MessagingChannelKey): string {
  if (channel === "telegram") return TELEGRAM_BOT_URL;
  if (channel === "imessage") return NATIVE_IMESSAGE_URL;
  return WHATSAPP_URL;
}

export function messagingChannelCta(channel: MessagingChannelKey): string {
  if (channel === "telegram") return "Open Telegram";
  if (channel === "imessage") return "Open iMessage";
  return "Open WhatsApp";
}
