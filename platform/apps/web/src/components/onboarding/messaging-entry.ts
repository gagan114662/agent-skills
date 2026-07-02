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

/**
 * Only Telegram is a live messaging room today (#1549). iMessage and WhatsApp are not live yet — the
 * homepage must not hand a visitor a dead click, so callers gate them behind an honest "notify me"
 * state that matches the /everyday dashboard rather than navigating to a generic `wa.me/` / `imessage://`.
 */
export function isMessagingChannelLive(channel: MessagingChannelKey): boolean {
  return channel === "telegram";
}

/**
 * Telegram bot deep-link that carries the visitor's typed brief as a base64url `?start=` payload, so the
 * bot opens already knowing the product/site (#1549). Telegram limits the start payload to 64 characters
 * from the `[A-Za-z0-9_-]` alphabet; base64url fits that alphabet exactly, and we cap the source to 48
 * bytes (48 bytes → 64 base64 chars) so the payload can never overflow. Empty input → the bare bot URL.
 */
export function telegramDeepLink(input: string): string {
  const payload = telegramStartPayload(input);
  return payload ? `${TELEGRAM_BOT_URL}?start=${payload}` : TELEGRAM_BOT_URL;
}

export function telegramStartPayload(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  // Cap the UTF-8 source at 48 bytes so the base64url payload stays within Telegram's 64-char limit.
  const bytes = new TextEncoder().encode(trimmed).slice(0, 48);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // btoa is present in browsers (DOM) and the SSR runtime (Node ≥16), so no polyfill is needed.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
