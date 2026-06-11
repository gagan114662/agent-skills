/**
 * SSO seam (issue #151, ADR-0151) — INTERFACE ONLY, not implemented.
 *
 * The issue scopes SSO to "a documented seam, not built now". This file declares the shape a future
 * SAML/OIDC integration would implement and ships a `DisabledSsoProvider` default that always declines —
 * so the wiring point exists and is typed, but no IdP, no network, and no auth bypass exist today. A real
 * provider (Okta, Entra, Google Workspace) is its own future ADR; until then the `/security` page lists
 * SSO as roadmap, honestly.
 */

/** What a verified SSO assertion yields: the workspace + the user's email + their (already-mapped) role. */
export interface SsoAssertion {
  workspaceId: string;
  email: string;
  /** The workspace role the IdP/group mapping grants (owner | approver | viewer). */
  role: "owner" | "approver" | "viewer";
}

export interface SsoProvider {
  /** True when this deployment has an SSO IdP configured. The default is always false. */
  readonly enabled: boolean;
  /**
   * Verify an opaque IdP assertion (SAML response / OIDC id_token) and return the mapped identity, or
   * null when SSO is disabled / the assertion is invalid. The default implementation always returns null.
   */
  resolveAssertion(rawAssertion: string): Promise<SsoAssertion | null>;
}

/** The default: SSO is off. No IdP, no network, no implicit access — the honest current state. */
export class DisabledSsoProvider implements SsoProvider {
  readonly enabled = false;
  resolveAssertion(): Promise<SsoAssertion | null> {
    return Promise.resolve(null);
  }
}
