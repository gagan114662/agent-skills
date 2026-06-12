import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack request signature verification (issue #170, ADR-0170). **Pure** and SDK-free (node:crypto) so
 * it runs in the no-DB/no-network unit job — the same discipline as the #98 Stripe-webhook helper, but
 * Slack's scheme (we share the *discipline*, not the parser).
 *
 * Slack signs each delivery with two headers — `X-Slack-Request-Timestamp: <unix-seconds>` and
 * `X-Slack-Signature: v0=<hex>` — where `<hex> = HMAC-SHA256(signing_secret, `v0:${timestamp}:${rawBody}`)`.
 * Verification recomputes the HMAC over the **raw** body, compares it in constant time, and rejects a
 * timestamp outside a tolerance window (the replay protection — an attacker cannot re-send a
 * captured-but-old valid delivery). The raw body is required because any re-serialization would change
 * the bytes the signature covers.
 */

const SIGNED_VERSION = "v0";

/** Thrown when a Slack signature is missing, malformed, forged, or outside the tolerance window. */
export class SlackVerificationError extends Error {
  constructor(detail = "invalid slack signature") {
    super(detail);
    this.name = "SlackVerificationError";
  }
}

export interface SlackVerifyOptions {
  /** Injectable clock (tests pin it); defaults to now. */
  now?: Date;
  /** Max allowed age of the signature timestamp, in seconds. Default 300 (Slack's recommendation). */
  toleranceSec?: number;
}

/** Compute the `v0` HMAC-SHA256 hex over `v0:${timestamp}:${rawBody}` for the given secret. */
function computeSignature(rawBody: string, secret: string, timestampSec: number): string {
  return createHmac("sha256", secret)
    .update(`${SIGNED_VERSION}:${timestampSec}:${rawBody}`)
    .digest("hex");
}

/**
 * Build the `v0=<hex>` signature header for `rawBody` at `timestampSec`. Used by the demo + tests to
 * produce a valid delivery; a real Slack delivery arrives with this header already set.
 */
export function signSlackRequest(rawBody: string, secret: string, timestampSec: number): string {
  return `${SIGNED_VERSION}=${computeSignature(rawBody, secret, timestampSec)}`;
}

/** Constant-time hex comparison that never throws on a length/format mismatch. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify a Slack request's signature over its **raw** body. Throws {@link SlackVerificationError} on a
 * missing/malformed header, a secret/body mismatch, or a timestamp outside the tolerance window
 * (replay). Resolves silently on success.
 */
export function verifySlackSignature(
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  secret: string,
  opts: SlackVerifyOptions = {},
): void {
  if (!secret) throw new SlackVerificationError("no signing secret configured");
  if (!timestampHeader) throw new SlackVerificationError("missing timestamp header");
  if (!signatureHeader) throw new SlackVerificationError("missing signature header");

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) throw new SlackVerificationError("malformed timestamp header");

  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const tolerance = opts.toleranceSec ?? 300;
  if (Math.abs(nowSec - ts) > tolerance) {
    throw new SlackVerificationError("signature timestamp outside tolerance window");
  }

  if (!signatureHeader.startsWith(`${SIGNED_VERSION}=`)) {
    throw new SlackVerificationError("malformed signature header");
  }
  const provided = signatureHeader.slice(SIGNED_VERSION.length + 1);
  const expected = computeSignature(rawBody, secret, ts);
  if (!safeEqualHex(expected, provided)) {
    throw new SlackVerificationError("signature mismatch");
  }
}
