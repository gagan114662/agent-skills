import type { CustomerIdentityConfig } from "../config/schema.js";

/**
 * Customer-facing identity (#389, ADR-0389) — the stable "face that sells" the fleet PRESENTS on outbound,
 * customer-facing touchpoints (a display name + avatar/face + optional voice-profile id + tagline), so it
 * shows up as one credible person instead of an anonymous bot.
 *
 * This module is IDENTITY/DISPLAY ONLY. It resolves and sanitizes display fields; it adds NO action path.
 * Every real outbound send/publish still flows through the existing #13 approval gate and the existing
 * connectors — resolving an identity here authorizes nothing. The resolver is PURE (no clock, no IO): it
 * reads the already-layered config (#58) and returns a sanitized value object or null.
 *
 * Default OFF, owner-workspace-first (fail-closed): an identity is presented ONLY when the flag is on AND
 * the caller is the named owner workspace. Enabling without naming the owner (named-nobody) presents to
 * nobody — the safest default. A deployment that sets no `customerIdentity` block changes nothing.
 *
 * Disclosure: the presented identity must remain truthful about being an AI agent wherever disclosure is
 * required. Nothing here licenses impersonation; downstream surfaces are responsible for the AI disclosure.
 */

/** Hard cap on a presented free-text field (a name/tagline, not an essay) — bounds #200 untrusted display. */
export const MAX_IDENTITY_TEXT_CHARS = 120;

/** Hard cap on an opaque id (voice profile) rendered into the identity. */
const MAX_IDENTITY_ID_CHARS = 128;

/** The sanitized customer-facing identity the fleet presents. Display-only; never authorizes a send. */
export interface CustomerIdentity {
  /** The display name presented on customer-facing comms (sanitized, length-capped). */
  founderName: string;
  /** A well-formed http(s) avatar (face) URL, or null when none was supplied / it was malformed. */
  avatarUrl: string | null;
  /** An opaque, sanitized voice-profile id for downstream synthesis, or null when none was supplied. */
  voiceProfileId: string | null;
  /** A short sanitized tagline shown alongside the identity, or null when none was supplied. */
  tagline: string | null;
}

/**
 * Sanitize an untrusted free-text display field (#200): drop C0/C1 control characters (no ANSI / newline
 * injection into a rendered line), collapse whitespace runs, trim, and hard-cap the length. Mirrors
 * `agent-channel-bridge/compose.ts#sanitizeData`. Returns "" for an all-blank/empty input.
 */
export function sanitizeIdentityText(text: string, maxChars: number = MAX_IDENTITY_TEXT_CHARS): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += " ";
    } else {
      out += ch;
    }
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > maxChars ? `${out.slice(0, maxChars).trim()}…` : out;
}

/**
 * Validate that a candidate avatar URL is a well-formed absolute http(s) URL. Returns the normalized URL
 * string on success, or null on anything else (malformed, non-absolute, or a non-http(s) scheme such as
 * `javascript:` / `data:`). Pure — no network probe; it only checks the shape so a bad value is omitted.
 */
export function sanitizeAvatarUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}

/**
 * Resolve the customer-facing identity for a workspace from the layered config. Returns the sanitized
 * identity ONLY when the flag is active for this workspace (enabled AND named-owner match); null otherwise
 * (off, named-nobody, or a non-owner caller) — fail-closed. PURE: no clock, no IO.
 *
 * When active but no display name is configured, the identity is still incomplete to present, so this
 * returns null (there is no credible face without a name). Each free-text field is sanitized for #200
 * display; a malformed avatar URL is omitted (null) rather than presented.
 */
export function resolveCustomerIdentity(
  cfg: CustomerIdentityConfig | undefined,
  workspaceId: string,
): CustomerIdentity | null {
  if (!cfg?.enabled) return null;
  // Owner-workspace-first, fail-closed: unset owner ⇒ nobody; a non-owner caller ⇒ nobody.
  if (!cfg.ownerWorkspaceId || cfg.ownerWorkspaceId !== workspaceId) return null;

  const founderName = cfg.founderName ? sanitizeIdentityText(cfg.founderName) : "";
  // No credible face without a presented name — incomplete identity ⇒ present nothing.
  if (founderName === "") return null;

  const avatarUrl = cfg.avatarUrl ? sanitizeAvatarUrl(cfg.avatarUrl) : null;
  const voiceProfileRaw = cfg.voiceProfileId
    ? sanitizeIdentityText(cfg.voiceProfileId, MAX_IDENTITY_ID_CHARS)
    : "";
  const taglineRaw = cfg.tagline ? sanitizeIdentityText(cfg.tagline) : "";

  return {
    founderName,
    avatarUrl,
    voiceProfileId: voiceProfileRaw === "" ? null : voiceProfileRaw,
    tagline: taglineRaw === "" ? null : taglineRaw,
  };
}
