/**
 * Pure inbound-lead helpers (GAP 1 of the leads centre, ADR-0400). The public landing form posts
 * untrusted free text; this module is the injection-defense + mapping layer between the route and both
 * the persistence row and the #222 discovery signal. Pure (no clock, no IO): every branch is unit-tested
 * without a DB or a network.
 *
 * #200 §6: name / email / message are UNTRUSTED DATA. {@link sanitizeLeadField} strips C0/C1 control
 * characters (no ANSI / newline injection), collapses whitespace, trims and hard-caps the length;
 * {@link isPlausibleEmail} validates the shape conservatively (a real "way to reply", not a deliverability
 * check). Nothing here ever runs the content as an instruction.
 */

/** Hard caps so a crafted field can neither flood a row nor a channel. */
export const MAX_NAME_CHARS = 120;
export const MAX_EMAIL_CHARS = 254; // RFC 5321 max email length
export const MAX_MESSAGE_CHARS = 2000;

/**
 * Strip control characters from an untrusted field, collapse whitespace, trim, and cap the length. Mirrors
 * `agent-channel-bridge/compose.ts#sanitizeData` — the same DATA-handling discipline.
 */
export function sanitizeLeadField(value: string, maxChars: number): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += " ";
    } else {
      out += ch;
    }
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > maxChars ? out.slice(0, maxChars).trim() : out;
}

/**
 * Conservative email-shape check: one `@`, a non-empty local part, and a dotted domain with a 2+ char TLD,
 * no whitespace. Not a deliverability guarantee — just enough that we are not persisting obvious garbage.
 */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export interface RawLeadInput {
  name?: unknown;
  email?: unknown;
  message?: unknown;
  source?: unknown;
  trackingRef?: unknown;
}

export interface SanitizedLead {
  name: string | null;
  email: string;
  message: string;
  source: string;
  trackingRef: string | null;
}

export type SanitizeLeadResult =
  | { ok: true; lead: SanitizedLead }
  | { ok: false; error: string };

const SOURCE_RE = /^[a-z0-9_]{1,40}$/;
const TRACKING_REF_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Validate + sanitize a raw inbound-lead body into a persistable {@link SanitizedLead}, or return a
 * stable 400 reason. Rejects an empty email/message (the rate-limit-safe minimum the task requires) and an
 * email that does not even look like an email. `source` defaults to `landing_form` and is constrained to a
 * structural label; `trackingRef` is dropped unless it matches the #386 ref shape (untrusted, so we never
 * persist arbitrary text into the attribution join key).
 */
export function sanitizeLead(input: RawLeadInput): SanitizeLeadResult {
  const rawEmail = typeof input.email === "string" ? input.email : "";
  const email = sanitizeLeadField(rawEmail, MAX_EMAIL_CHARS).toLowerCase();
  if (!email) return { ok: false, error: "email is required" };
  if (!isPlausibleEmail(email)) return { ok: false, error: "email is not a valid address" };

  const message = sanitizeLeadField(
    typeof input.message === "string" ? input.message : "",
    MAX_MESSAGE_CHARS,
  );
  if (!message) return { ok: false, error: "message is required" };

  const rawName = typeof input.name === "string" ? sanitizeLeadField(input.name, MAX_NAME_CHARS) : "";
  const name = rawName.length > 0 ? rawName : null;

  const rawSource = typeof input.source === "string" ? input.source.trim().toLowerCase() : "";
  const source = SOURCE_RE.test(rawSource) ? rawSource : "landing_form";

  const rawRef = typeof input.trackingRef === "string" ? input.trackingRef.trim() : "";
  const trackingRef = TRACKING_REF_RE.test(rawRef) ? rawRef : null;

  return { ok: true, lead: { name, email, message, source, trackingRef } };
}

/**
 * A discovery signal mapped from a captured lead (GAP 1 → #222). An inbound web lead is a hand-raise: a
 * prospect who identified themselves with real buying intent, so it maps to a `role_identified` signal.
 * The prospect key MUST be opaque (no PII — the discovery layer refuses an email-looking key), so we hash
 * the email into a stable, opaque token rather than passing the address through.
 */
export interface DiscoverySignalForLead {
  prospectKey: string;
  kind: "role_identified";
  role: string;
  source: string;
  detail: Record<string, unknown>;
}

/**
 * Map a sanitized lead → a discovery signal input. `prospectKeyHash` is supplied by the caller (the hash is
 * IO-adjacent — Node's crypto — so it stays out of this pure function); everything else is derived purely.
 * The email is NEVER placed in the prospect key (PII), only the opaque hash is.
 */
export function toDiscoverySignal(
  lead: SanitizedLead,
  prospectKeyHash: string,
): DiscoverySignalForLead {
  return {
    prospectKey: `lead_${prospectKeyHash}`,
    kind: "role_identified",
    role: "inbound_lead",
    source: lead.source,
    // The message is untrusted DATA carried for context only; discovery never executes it.
    detail: { source: lead.source, hasName: lead.name !== null, messageLength: lead.message.length },
  };
}
