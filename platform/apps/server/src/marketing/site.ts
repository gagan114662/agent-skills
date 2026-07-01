/**
 * The workspace site-URL resolver (#250) — pure, no IO.
 *
 * `{{site}}` is the template variable a seeded SEO task carries ("Run an SEO audit of {{site}}"). Before
 * #250 it rendered to the literal placeholder `"our website"` because there was no canonical source for
 * a workspace's real domain — so the fleet's web tools had no real URL to point at and the audit was
 * vacuous. This resolves the real site URL to substitute instead:
 *
 *   1. An explicitly-configured `marketing.siteUrl` always wins (a customer who connected their domain).
 *   2. Otherwise the OWNER's own workspace (`marketing.ownerWorkspaceId`) falls back to ipop's own site,
 *      the configured public app origin — ipop dogfooding its marketing on its real domain (#235).
 *   3. Any other workspace with nothing configured returns `undefined` (the caller keeps the existing
 *      `"our website"` placeholder — we never invent a fake domain for a customer).
 *
 * Pure ⇒ unit-testable without a DB or config IO; the caller (`automations/engine.ts`) reads the config
 * and passes the two fields in.
 */

import { DEFAULT_PUBLIC_APP_ORIGIN } from "../product-origins.js";

/** ipop's own public marketing site — the owner-workspace fallback when no `siteUrl` is configured. */
export const IPOP_SITE_URL = DEFAULT_PUBLIC_APP_ORIGIN;

export interface ResolveSiteUrlInput {
  /** The workspace the task is being rendered for. */
  workspaceId: string;
  /** The owner's own workspace id (`marketing.ownerWorkspaceId`), if set. */
  ownerWorkspaceId?: string;
  /** An explicitly-configured site URL (`marketing.siteUrl`), if set. */
  configuredSiteUrl?: string;
}

/**
 * Resolve the real site URL for a workspace, or `undefined` when none is known. A configured URL is
 * normalised to include a scheme (a bare `example.com` becomes `https://example.com`) so it is a real,
 * fetchable target for the web tools. Returns `undefined` rather than a placeholder — the caller decides
 * the fallback (keep the template's `"our website"` default).
 */
export function resolveSiteUrl(input: ResolveSiteUrlInput): string | undefined {
  const configured = input.configuredSiteUrl?.trim();
  if (configured) return normaliseUrl(configured);
  if (input.ownerWorkspaceId !== undefined && input.ownerWorkspaceId === input.workspaceId) {
    return IPOP_SITE_URL;
  }
  return undefined;
}

/** Add an `https://` scheme to a bare host so the value is always a fetchable URL. */
function normaliseUrl(url: string): string {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `https://${url}`;
}
