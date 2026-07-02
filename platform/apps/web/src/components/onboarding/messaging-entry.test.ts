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
