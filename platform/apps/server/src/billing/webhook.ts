import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe-style webhook signature verification (issue #98, ADR-0043). **Pure** and SDK-free (node:crypto)
 * so it runs in the no-DB/no-network unit job and is identical regardless of the configured provider —
 * the same discipline as the #13 pure policy engine.
 *
 * Stripe signs each delivery with a header `Stripe-Signature: t=<unix-seconds>,v1=<hex>` where
 * `<hex> = HMAC-SHA256(secret, `${t}.${rawBody}`)`. Verification recomputes the HMAC over the **raw**
 * body, compares it in constant time, and rejects a timestamp outside a tolerance window — which is the
 * replay protection (an attacker cannot re-send a captured-but-old valid delivery). The raw body is
 * required because any re-serialization would change the bytes the signature covers.
 */

const SIGNED_SCHEME = "v1";

/** Thrown when a webhook signature is missing, malformed, forged, or outside the tolerance window. */
export class WebhookVerificationError extends Error {
  constructor(detail = "invalid webhook signature") {
    super(detail);
    this.name = "WebhookVerificationError";
  }
}

export interface VerifyOptions {
  /** Injectable clock (tests pin it); defaults to now. */
  now?: Date;
  /** Max allowed age of the signature timestamp, in seconds. Default 300 (Stripe's recommendation). */
  toleranceSec?: number;
}

/** Compute the `v1` HMAC-SHA256 hex over `${timestamp}.${rawBody}` for the given secret. */
function computeSignature(rawBody: string, secret: string, timestampSec: number): string {
  return createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
}

/**
 * Build a signature header for `rawBody` at `timestampSec`. Used by the demo + tests to produce a valid
 * delivery; a real Stripe delivery arrives with this header already set.
 */
export function signWebhookPayload(rawBody: string, secret: string, timestampSec: number): string {
  return `t=${timestampSec},${SIGNED_SCHEME}=${computeSignature(rawBody, secret, timestampSec)}`;
}

/** Parse a `t=...,v1=...` header into its parts, or null if malformed. */
function parseHeader(header: string): { t: number; v1: string } | null {
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) {
      const n = Number(value);
      if (Number.isFinite(n)) t = n;
    } else if (key === SIGNED_SCHEME && value) {
      v1 = value;
    }
  }
  return t !== null && v1 !== null ? { t, v1 } : null;
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
 * Verify a webhook's signature over its **raw** body. Throws {@link WebhookVerificationError} on a
 * missing/malformed header, a secret/body mismatch, or a timestamp outside the tolerance window
 * (replay). Resolves silently on success.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  opts: VerifyOptions = {},
): void {
  if (!secret) throw new WebhookVerificationError("no webhook secret configured");
  if (!signatureHeader) throw new WebhookVerificationError("missing signature header");
  const parsed = parseHeader(signatureHeader);
  if (!parsed) throw new WebhookVerificationError("malformed signature header");

  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const tolerance = opts.toleranceSec ?? 300;
  if (Math.abs(nowSec - parsed.t) > tolerance) {
    throw new WebhookVerificationError("signature timestamp outside tolerance window");
  }

  const expected = computeSignature(rawBody, secret, parsed.t);
  if (!safeEqualHex(expected, parsed.v1)) {
    throw new WebhookVerificationError("signature mismatch");
  }
}
