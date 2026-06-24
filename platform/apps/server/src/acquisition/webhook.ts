import { createHmac, timingSafeEqual } from "node:crypto";
import { reasonFromWebhook, normalizeRecipient, type SuppressionReason } from "./compliance.js";

/**
 * ESP bounce/complaint webhook ingest (issue #189, ADR-0189, AC2). **Pure** + SDK-free (node:crypto):
 * verify an HMAC-SHA256 signature over the raw body, parse the ESP's events, and map each
 * bounce/complaint/unsubscribe onto a suppression. The route captures the raw bytes (so re-serialization
 * can't change what the signature covers) and persists the suppressions. Keeping the ESP's reputation
 * signals enforced in code is the whole point — a bounced/complained address never gets mailed again.
 */

/** Thrown when an ESP webhook signature is missing, malformed, or forged. */
export class EspWebhookVerificationError extends Error {
  constructor(detail = "invalid ESP webhook signature") {
    super(detail);
    this.name = "EspWebhookVerificationError";
  }
}

/**
 * Verify an `HMAC-SHA256(rawBody)` signature (hex) against the shared secret, constant-time. Throws on a
 * missing/forged signature. Mirrors the #98 billing webhook verifier (node:crypto, raw-body-covered).
 */
export function verifyEspSignature(rawBody: string, signature: string | undefined, secret: string): void {
  if (!secret) throw new EspWebhookVerificationError("no ESP webhook secret configured");
  if (!signature) throw new EspWebhookVerificationError("missing signature");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new EspWebhookVerificationError();
  }
}

/** One normalized suppression derived from an ESP event. */
export interface EspSuppression {
  recipient: string;
  reason: SuppressionReason;
  source: string;
}

/**
 * Map a parsed array of ESP events onto suppressions. Each event needs a recipient email and an event
 * type; only bounce/complaint/unsubscribe types yield a suppression (a `Delivered`/`Open` event yields
 * nothing). Recipients are normalized + de-duplicated. Defensive: malformed entries are skipped.
 */
export function decideEspSuppressions(events: unknown): EspSuppression[] {
  if (!Array.isArray(events)) return [];
  const out: EspSuppression[] = [];
  const seen = new Set<string>();
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const ev = raw as Record<string, unknown>;
    const email =
      typeof ev.email === "string"
        ? ev.email
        : typeof ev.recipient === "string"
          ? ev.recipient
          : null;
    const type =
      typeof ev.type === "string"
        ? ev.type
        : typeof ev.RecordType === "string" // Postmark
          ? ev.RecordType
          : typeof ev.event === "string" // SendGrid
            ? ev.event
            : null;
    if (!email || !type) continue;
    const reason = reasonFromWebhook(type);
    if (!reason) continue;
    const recipient = normalizeRecipient(email);
    if (!recipient || seen.has(recipient)) continue;
    seen.add(recipient);
    out.push({ recipient, reason, source: `esp:${type.toLowerCase()}` });
  }
  return out;
}

/** Parse the raw JSON body into an events array (Postmark single-object, or an array of events). */
export function parseEspBody(rawBody: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  // A single-event body (Postmark posts one event) — wrap it.
  if (parsed && typeof parsed === "object") return [parsed];
  return [];
}

export interface InboundEmailReply {
  externalRef: string;
  from: string | null;
  subject: string | null;
  body: string | null;
  inReplyTo: string | null;
  outreachMessageId: string | null;
  outreachRecipientRef: string | null;
  reachContactKey: string | null;
  occurredAt: Date | null;
}

function stringField(ev: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = ev[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function metadataField(ev: Record<string, unknown>, key: string): string | null {
  const metadata = ev.Metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nestedStringField(ev: Record<string, unknown>, objectKey: string, fieldKey: string): string | null {
  const object = ev[objectKey];
  if (!object || typeof object !== "object") return null;
  const value = (object as Record<string, unknown>)[fieldKey];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseInboundEmailReply(raw: unknown): InboundEmailReply | null {
  if (!raw || typeof raw !== "object") return null;
  const ev = raw as Record<string, unknown>;
  const recordType = stringField(ev, "RecordType", "type", "event");
  if (recordType && !recordType.toLowerCase().includes("inbound")) return null;
  const externalRef = stringField(ev, "MessageID", "MessageId", "messageId", "ID");
  if (!externalRef) return null;
  const body = stringField(ev, "StrippedTextReply", "TextBody", "HtmlBody", "Body");
  const occurredRaw = stringField(ev, "Date", "ReceivedAt", "receivedAt");
  const occurredAt = occurredRaw ? new Date(occurredRaw) : null;
  return {
    externalRef,
    from: nestedStringField(ev, "FromFull", "Email") ?? stringField(ev, "From", "Email"),
    subject: stringField(ev, "Subject"),
    body,
    inReplyTo: stringField(ev, "InReplyTo", "In-Reply-To", "OriginalMessageID"),
    outreachMessageId: metadataField(ev, "outreachMessageId"),
    outreachRecipientRef: metadataField(ev, "outreachRecipientRef"),
    reachContactKey: metadataField(ev, "reachContactKey") ?? stringField(ev, "MailboxHash"),
    occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
  };
}
