/**
 * Analytics auto-install + read — production wiring (issue #270).
 *
 * Binds the pure {@link AnalyticsService} to the layered config (#58), the read provider selected by config,
 * and the db install store. Safe to wire unconditionally: with the analytics flag off (the default),
 * {@link resolveAnalyticsFlags} returns all-off, every service method short-circuits (no provider call, no
 * DB write), and the founder console keeps reading the internal #102 funnel exactly as today.
 *
 * The read provider is selected by `analytics.provider` (`dryrun` default — reports nothing). A real GA4 /
 * Plausible read reads its vendor credential through the resolver; with central provisioning (#267) off /
 * no credential, the live providers also report nothing, so a connected-but-unread workspace honestly shows
 * "installed, awaiting first reading" rather than a fabricated number (premortem #200 §2).
 */

import { loadConfig } from "../config/loader.js";
import { dbAnalyticsInstallStore } from "../db/repositories/analytics.js";
import { resolveAnalyticsFlags, type AnalyticsFlags, type AnalyticsSiteContext } from "./decide.js";
import { selectAnalyticsProvider, type AnalyticsCredentialResolver } from "./providers.js";
import { AnalyticsService } from "./service.js";

/** Resolve the analytics flags for a workspace from the layered config (#58) — default-OFF, owner-first. */
export function analyticsFlagsFor(workspaceId: string): AnalyticsFlags {
  return resolveAnalyticsFlags(loadConfig(workspaceId).analytics, workspaceId);
}

/**
 * Resolve the structural site facts that decide the install method. ipop hosts customer pages by default
 * (#266 `IpopHosted` is the default publisher), so the tag is injected at render (`hosted_auto_inject`).
 * A real external-site-connector signal is a future refinement; until then a workspace's tag is hosted-
 * injected. Purely structural — the page body is never read (#200 §6).
 */
async function defaultSiteContextFor(_workspaceId: string): Promise<AnalyticsSiteContext> {
  return { hosted: true, externalSiteConnected: false };
}

/**
 * Resolve the vendor read credential for a workspace. The live GA4/Plausible read against the central #267
 * vault is a future ADR; until then no credential resolves (the live providers report nothing).
 */
const noCredential: AnalyticsCredentialResolver = async () => null;

/** Build the production analytics service over the real config, provider, and install store. */
export function buildAnalyticsService(): AnalyticsService {
  const provider = selectAnalyticsProvider(loadConfig().analytics.provider ?? "dryrun", noCredential);
  return new AnalyticsService({
    flagsFor: analyticsFlagsFor,
    siteContextFor: defaultSiteContextFor,
    provider,
    installs: dbAnalyticsInstallStore,
  });
}

/** Singleton-ish accessor for the console reader + route (cheap to rebuild; no per-call state). */
let cached: AnalyticsService | null = null;
export function defaultAnalyticsService(): AnalyticsService {
  cached ??= buildAnalyticsService();
  return cached;
}

/**
 * The analytics department proof tile, or `null` to fall back to the console's internal #102 funnel
 * reading. Used by `founder-console/default.ts` — strictly additive (the scorecard only ever gains the
 * externally-grounded site reading; it never loses the funnel number when the layer is off / unread).
 */
export async function analyticsTileReading(workspaceId: string) {
  return defaultAnalyticsService().tileReading(workspaceId);
}
