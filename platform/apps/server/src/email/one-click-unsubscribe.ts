import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeRecipient } from "../acquisition/compliance.js";

/**
 * One-click unsubscribe — RFC 8058 (issue #268, ADR-0268). CAN-SPAM / GDPR require a working unsubscribe;
 * RFC 8058 makes it *one click* by letting the mailbox provider POST the `List-Unsubscribe` URL on the
 * recipient's behalf (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`). The link must be unforgeable so
 * a malicious POST can't unsubscribe arbitrary addresses, so each link carries an HMAC token bound to the
 * (normalized) recipient — the token is over the email, never PII in the clear. Reuses the #189
 * suppression vocabulary: a verified one-click POST adds an `unsubscribe` suppression. Pure + SDK-free
 * (node:crypto only), so it is unit-tested offline.
 */

/**
 * Sign an HMAC-SHA256 token over the normalized recipient. The token goes in the `?u=` of the unsubscribe
 * URL so the receiver can prove the link was one we issued for that exact address. Throws on an empty secret
 * (a misconfiguration — we must never mint a forgeable token).
 */
export function signUnsubscribeToken(recipient: string, secret: string): string {
  if (!secret) throw new Error("no unsubscribe secret configured");
  return createHmac("sha256", secret).update(normalizeRecipient(recipient), "utf8").digest("hex");
}

/**
 * Verify a one-click unsubscribe token for a recipient, constant-time. Fails closed: a missing secret, a
 * missing/empty token, or a length mismatch all return false (never throw on the public POST path).
 */
export function verifyUnsubscribeToken(recipient: string, token: string, secret: string): boolean {
  if (!secret || !token) return false;
  const expected = signUnsubscribeToken(recipient, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The RFC 8058 List-Unsubscribe headers a compliant marketing email carries. */
export interface ListUnsubscribeHeaders {
  "List-Unsubscribe": string;
  "List-Unsubscribe-Post": string;
}

/**
 * Build the RFC 8058 headers. `List-Unsubscribe` carries the https one-click URL (and an optional mailto
 * fallback, in angle brackets, comma-separated); `List-Unsubscribe-Post` is the fixed one-click marker that
 * tells the mailbox provider it may POST the URL directly.
 */
export function buildListUnsubscribeHeaders(opts: {
  httpsUrl: string;
  mailto?: string;
}): ListUnsubscribeHeaders {
  const forms = [`<${opts.httpsUrl}>`];
  if (opts.mailto) forms.push(`<mailto:${opts.mailto}>`);
  return {
    "List-Unsubscribe": forms.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export interface OneClickUnsubscribeDecision {
  /** True when the token verified and a (normalized) recipient should be suppressed. */
  ok: boolean;
  /** The normalized recipient to suppress, or null when the request is not honored. */
  recipient: string | null;
  /** The suppression reason ("unsubscribe") on success, else why it was refused. */
  reason: string;
}

/**
 * Decide whether a one-click POST should add an `unsubscribe` suppression. Honored only when the recipient is
 * present AND the HMAC token verifies for that recipient (so only links we actually issued work). The caller
 * persists the suppression via the existing #189 `addSuppression` repository. Total + pure.
 */
export function decideOneClickUnsubscribe(input: {
  recipient: string;
  token: string;
  secret: string;
}): OneClickUnsubscribeDecision {
  const recipient = normalizeRecipient(input.recipient);
  if (!recipient) return { ok: false, recipient: null, reason: "no recipient" };
  if (!verifyUnsubscribeToken(recipient, input.token, input.secret)) {
    return { ok: false, recipient: null, reason: "invalid or expired unsubscribe token" };
  }
  return { ok: true, recipient, reason: "unsubscribe" };
}
