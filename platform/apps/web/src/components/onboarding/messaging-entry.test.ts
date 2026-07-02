/**
 * #1549 — the homepage hero must carry the visitor's typed brief into the messaging flow, and it must
 * not offer dead channels. These pure helpers own both promises: a Telegram deep-link that base64url-
 * encodes the typed value into a `?start=` payload, and an honest "is this channel live?" gate.
 */
import { describe, expect, it } from "vitest";
import {
  TELEGRAM_BOT_URL,
  isMessagingChannelLive,
  telegramDeepLink,
  telegramStartPayload,
} from "./messaging-entry.js";

describe("messaging-entry — Telegram deep-link payload (#1549)", () => {
  it("carries the typed value as a base64url ?start= payload the bot can decode", () => {
    const url = telegramDeepLink("getfoolish.com");
    expect(url.startsWith(`${TELEGRAM_BOT_URL}?start=`)).toBe(true);

    const payload = new URL(url).searchParams.get("start") ?? "";
    // base64url alphabet only — Telegram rejects anything else in a start payload.
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    // …and it round-trips back to exactly what the visitor typed.
    expect(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).toBe("getfoolish.com");
  });

  it("never exceeds Telegram's 64-char start limit, even for a long brief", () => {
    const long =
      "Map where our brand-new productivity suite can win first among remote engineering teams worldwide";
    const payload = telegramStartPayload(long);
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length).toBeLessThanOrEqual(64);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  const decodePayload = (payload: string): string => {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    // A FATAL decoder throws if any code point was cut mid-sequence into invalid UTF-8.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };

  it("never splits a multi-byte character straddling the 48-byte cut (#1585)", () => {
    // 47 ASCII bytes leave only 1 byte of headroom; a 4-byte 🌏 straddles the 48-byte cut and must be
    // dropped WHOLE, not sliced into an invalid lead byte. (The old byte-slice(0,48) produced garbage.)
    const brief = "x".repeat(47) + "🌏 the world awaits";
    const payload = telegramStartPayload(brief);

    expect(payload.length).toBeLessThanOrEqual(64);
    const decoded = decodePayload(payload); // throws here if a code point was split
    expect(decoded).toBe("x".repeat(47));
    expect(decoded).not.toContain("�");
  });

  it("preserves emoji/CJK that fit within the limit (#1585)", () => {
    const brief = "🚀🌏 东京 launch blitz";
    const decoded = decodePayload(telegramStartPayload(brief));

    expect(brief.startsWith(decoded)).toBe(true);
    expect(decoded).toContain("🚀");
    expect(decoded).toContain("🌏");
    expect(decoded).toContain("东京");
    expect(decoded).not.toContain("�");
  });

  it("falls back to the bare bot URL for an empty or whitespace-only value", () => {
    expect(telegramDeepLink("")).toBe(TELEGRAM_BOT_URL);
    expect(telegramDeepLink("   ")).toBe(TELEGRAM_BOT_URL);
    expect(telegramStartPayload("")).toBe("");
  });
});

describe("messaging-entry — live-channel honesty (#1549)", () => {
  it("treats only Telegram as a live room; iMessage and WhatsApp are not live yet", () => {
    expect(isMessagingChannelLive("telegram")).toBe(true);
    expect(isMessagingChannelLive("imessage")).toBe(false);
    expect(isMessagingChannelLive("whatsapp")).toBe(false);
  });
});
