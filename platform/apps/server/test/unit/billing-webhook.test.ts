import { describe, it, expect } from "vitest";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  WebhookVerificationError,
} from "../../src/billing/webhook.js";

/**
 * Stripe-style webhook signature verification (#98) — pure, SDK-free (node:crypto), so the
 * signature + replay tests are real and hermetic. The scheme is `t=<ts>,v1=<hex HMAC-SHA256 of
 * `${t}.${rawBody}`>`; verification rejects a forged signature OR a timestamp outside the tolerance
 * window (replay protection).
 */
const SECRET = "whsec_test_secret_value_123";
const BODY = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
const NOW = new Date("2026-06-10T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

describe("verifyWebhookSignature (#98 — Stripe signature scheme, pure)", () => {
  it("verifies a payload signed with the same secret + a fresh timestamp", () => {
    const header = signWebhookPayload(BODY, SECRET, NOW_SEC);
    expect(() =>
      verifyWebhookSignature(BODY, header, SECRET, { now: NOW, toleranceSec: 300 }),
    ).not.toThrow();
  });

  it("rejects a tampered body (the signature no longer matches)", () => {
    const header = signWebhookPayload(BODY, SECRET, NOW_SEC);
    expect(() =>
      verifyWebhookSignature(BODY + " ", header, SECRET, { now: NOW, toleranceSec: 300 }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects the wrong secret", () => {
    const header = signWebhookPayload(BODY, SECRET, NOW_SEC);
    expect(() =>
      verifyWebhookSignature(BODY, header, "whsec_wrong_secret", { now: NOW, toleranceSec: 300 }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects a malformed signature header", () => {
    expect(() =>
      verifyWebhookSignature(BODY, "not-a-valid-header", SECRET, { now: NOW }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects a timestamp outside the tolerance window (replay protection)", () => {
    const stale = signWebhookPayload(BODY, SECRET, NOW_SEC - 10_000);
    expect(() =>
      verifyWebhookSignature(BODY, stale, SECRET, { now: NOW, toleranceSec: 300 }),
    ).toThrow(WebhookVerificationError);
  });

  it("accepts a timestamp inside the tolerance window", () => {
    const recent = signWebhookPayload(BODY, SECRET, NOW_SEC - 60);
    expect(() =>
      verifyWebhookSignature(BODY, recent, SECRET, { now: NOW, toleranceSec: 300 }),
    ).not.toThrow();
  });
});
