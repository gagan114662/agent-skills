/**
 * Enterprise "Passport"-style IdP/SSO gate (issue #340, ADR-0340), modeled on Vercel Ship 26's Passport:
 * every internal surface — the v5 console + the department agents — sits behind the customer's IdP/SSO, and
 * nothing internal is publicly exposed. This module is the PURE access decision; the Fastify wiring that
 * composes it over the existing `requireIdentity` guard lives in `passport-gate.ts`.
 *
 * Default-OFF (the live enforcement path is flag-gated, owner-workspace-first via `caps.ts`): when the gate
 * is off, {@link decidePassport} returns `open` and adds NO requirement, so existing auth is unchanged. When
 * an owner turns it on, the gate denies anything that is not an authenticated session carrying a VERIFIED
 * assertion from an ALLOW-LISTED IdP.
 *
 * Premortem (#200 §6) injection defense: the IdP provider name is UNTRUSTED input. It is matched against the
 * allow-list with strict normalization ({@link isAllowedIdpProvider}: trim + lower-case + a conservative
 * character whitelist) so a provider carrying control characters / markup never matches — a poisoned or forged
 * provider string can never slip past the allow-list. The `verified` flag must come from a trusted server-side
 * session marker (supplied by the wiring), never a self-asserted request header.
 */

/** A resolved SSO assertion for the caller. `verified` MUST be established server-side, never client-claimed. */
export interface IdpAssertion {
  /** The IdP that minted the session (e.g. `google`, `okta`). UNTRUSTED — checked against the allow-list. */
  provider: string;
  /** The IdP subject (stable user id) — carried for audit, never used to decide access. */
  subject: string;
  /** True only when the session was actually established through the IdP (a trusted server-side fact). */
  verified: boolean;
}

/** Everything the pure gate needs to decide. The wiring assembles this per request. */
export interface PassportInput {
  /** Is the Passport gate enforced for this workspace? (flag-gated, owner-first — default false). */
  enabled: boolean;
  /** Did the existing auth layer resolve an identity for the caller? */
  identityPresent: boolean;
  /** The caller's verified IdP assertion, or null when the session did not come through an IdP. */
  assertion: IdpAssertion | null;
  /** The IdP providers this workspace trusts. An empty list with the gate on ⇒ fully dark (deny all). */
  allowedProviders: readonly string[];
}

/** Why the gate admitted or refused the caller. */
export type PassportStatus =
  /** Gate off — pass-through; the route's own auth still applies. */
  | "open"
  /** Gate on, verified + allow-listed IdP — admitted. */
  | "authenticated"
  /** Gate on, no authenticated identity — denied (nothing internal is publicly exposed). */
  | "unauthenticated"
  /** Gate on, authenticated but no verified IdP assertion — denied. */
  | "sso_required"
  /** Gate on, verified assertion but the IdP is not allow-listed — denied. */
  | "forbidden_idp";

export interface PassportDecision {
  allow: boolean;
  status: PassportStatus;
  reason: string;
}

/** A conservative provider-handle whitelist: lower-case letters, digits, and `_ . -` only. */
const PROVIDER_HANDLE_RE = /^[a-z0-9_.-]+$/;

/**
 * Whether `provider` is one of the workspace's `allowed` IdPs. UNTRUSTED input is normalized strictly: trim,
 * lower-case, then require a conservative character whitelist — a provider carrying control characters or
 * markup fails the whitelist and never matches (premortem §6). The allow-list entries are normalized the same
 * way. Pure + total; a non-string / empty / malformed provider returns false.
 */
export function isAllowedIdpProvider(provider: unknown, allowed: readonly string[]): boolean {
  if (typeof provider !== "string") return false;
  const candidate = provider.trim().toLowerCase();
  if (candidate.length === 0 || !PROVIDER_HANDLE_RE.test(candidate)) return false;
  for (const a of allowed) {
    if (typeof a === "string" && a.trim().toLowerCase() === candidate) return true;
  }
  return false;
}

/**
 * Decide whether the Passport gate admits the caller. Fail-closed order:
 *   1. gate off                         → `open` (allow; no added requirement)
 *   2. no authenticated identity        → `unauthenticated` (deny)
 *   3. no verified IdP assertion        → `sso_required` (deny — even a legacy session must come via the IdP)
 *   4. IdP not allow-listed             → `forbidden_idp` (deny)
 *   5. verified + allow-listed IdP      → `authenticated` (allow)
 * Pure + total.
 */
export function decidePassport(input: PassportInput): PassportDecision {
  if (!input.enabled) {
    return { allow: true, status: "open", reason: "passport gate off — existing auth applies" };
  }
  if (!input.identityPresent) {
    return { allow: false, status: "unauthenticated", reason: "authentication required" };
  }
  const a = input.assertion;
  if (!a || a.verified !== true) {
    return { allow: false, status: "sso_required", reason: "single sign-on through your IdP is required" };
  }
  if (!isAllowedIdpProvider(a.provider, input.allowedProviders)) {
    return { allow: false, status: "forbidden_idp", reason: "this identity provider is not permitted" };
  }
  return { allow: true, status: "authenticated", reason: "authenticated via an allow-listed IdP" };
}
