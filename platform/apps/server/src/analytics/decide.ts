/**
 * Analytics auto-install + read — the pure decision brain (issue #270).
 *
 * Lens (the analytics department lead, #123) cannot report a single real number until an analytics tag is
 * actually on the customer's site. #270's promise is that the OWNER never does tag or code work: ipop puts
 * the tag on automatically. This module decides, purely, HOW that tag gets installed for a given site and
 * WHETHER the analytics layer is even active for a workspace.
 *
 * Two properties are encoded here, not by convention:
 *
 *  1. **Default OFF, owner-workspace-first (mirrors `delivery`/`seo`).** {@link resolveAnalyticsFlags}
 *     returns all-off unless the master flag is on AND (broadened explicitly OR this is the owner's own
 *     workspace). A deployment that sets nothing reads no provider and writes no install — the founder
 *     console keeps reading the internal #102 funnel exactly as today.
 *
 *  2. **The install method is STRUCTURAL.** {@link decideAnalyticsInstall} chooses the install path from
 *     how the site is hosted — an ipop-hosted page gets the tag injected at render; a connected external
 *     site gets it through the site connector; an unconfigured site is `manual_pending` (nothing claimed).
 *     It never inspects page content (injection defense, premortem #200 §6): a poisoned page body can never
 *     redirect where the tag goes.
 *
 * Pure + dependency-free so it runs in the no-DB unit job and is the single source of truth for "is Lens's
 * analytics layer on, and how does its tag reach this site?".
 */

/**
 * How ipop puts the analytics tag on a site without the owner touching code (#270 acceptance):
 *  - `hosted_auto_inject` — the page is ipop-hosted (#266); the tag is injected into the rendered HTML.
 *  - `connector_inject`   — a connected external site (#258); ipop installs the tag through the connector.
 *  - `manual_pending`     — no hosting/connector resolved yet; nothing is claimed installed (honest).
 */
export const ANALYTICS_INSTALL_METHODS = [
  "hosted_auto_inject",
  "connector_inject",
  "manual_pending",
] as const;
export type AnalyticsInstallMethod = (typeof ANALYTICS_INSTALL_METHODS)[number];

/** The structural facts about a workspace's site that decide how the tag is installed. */
export interface AnalyticsSiteContext {
  /** The site is served by ipop hosted publishing (#266) — the tag is injected at render. */
  hosted: boolean;
  /** An external site is connected through the site connector (#258) — the tag is installed via it. */
  externalSiteConnected: boolean;
}

/**
 * Choose the tag-install path from how the site is hosted. Hosted wins (the most automatic path); a
 * connected external site is next; otherwise `manual_pending` — never a fabricated "installed". Purely
 * structural: the page body is never read.
 */
export function decideAnalyticsInstall(site: AnalyticsSiteContext): AnalyticsInstallMethod {
  if (site.hosted) return "hosted_auto_inject";
  if (site.externalSiteConnected) return "connector_inject";
  return "manual_pending";
}

/** True when the chosen method actually puts a tag on the site (so Lens can begin to report). */
export function isAnalyticsTagInstalled(method: AnalyticsInstallMethod): boolean {
  return method === "hosted_auto_inject" || method === "connector_inject";
}

/** The config partial {@link resolveAnalyticsFlags} reads (a slice of `analyticsSchema`). */
export interface AnalyticsConfigInput {
  enabled?: boolean;
  ownerWorkspaceOnly?: boolean;
  ownerWorkspaceId?: string;
  provider?: string;
  measurementId?: string;
}

/** The resolved, per-workspace analytics flags. `enabled:false` ⇒ the layer does nothing. */
export interface AnalyticsFlags {
  enabled: boolean;
  /** The read provider id (`dryrun` default — reports nothing; `ga4` | `plausible` read real metrics). */
  provider: string;
  /** The GA4 measurement id / Plausible domain to inject (empty ⇒ the snippet is a no-op placeholder). */
  measurementId: string;
}

export const ANALYTICS_FLAGS_OFF: AnalyticsFlags = {
  enabled: false,
  provider: "dryrun",
  measurementId: "",
};

/**
 * Resolve the analytics flags for a workspace — default OFF, owner-workspace-first (identical gate to
 * {@link resolveDeliveryFlags}). The master `enabled` must be on AND, when `ownerWorkspaceOnly` (default
 * true), the workspace must be the named owner workspace. Turning `enabled` on without naming the owner
 * workspace activates the layer for NObody (the safest default).
 */
export function resolveAnalyticsFlags(
  config: AnalyticsConfigInput | undefined,
  workspaceId: string,
): AnalyticsFlags {
  if (!config || config.enabled !== true) return ANALYTICS_FLAGS_OFF;
  const ownerOnly = config.ownerWorkspaceOnly !== false; // default true
  const inScope = ownerOnly
    ? config.ownerWorkspaceId !== undefined && config.ownerWorkspaceId === workspaceId
    : true;
  if (!inScope) return ANALYTICS_FLAGS_OFF;
  return {
    enabled: true,
    provider: config.provider && config.provider.trim() !== "" ? config.provider : "dryrun",
    measurementId: config.measurementId ?? "",
  };
}
