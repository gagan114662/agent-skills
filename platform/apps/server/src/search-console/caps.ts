/**
 * Resolved Search Console auto-submit policy (#265). Lives on the EXISTING `seo` config block (no new
 * block): the same owner-first marker (`seo.ownerWorkspaceId`) gates both rank tracking (#294) and this.
 *
 * Default OFF + `dryrun` provider, owner-workspace-first (premortem §4 + #200 rollout discipline): an
 * un-configured workspace submits nothing and reports nothing. `autoSubmitEnabled` is the master flag that
 * decides whether the service will even PARK a #13 approval for a workspace; even with it ON, the live
 * submit is still #13-gated AND the provider is still dry-run — three independent safety layers.
 */
import type { SeoConfig } from "../config/schema.js";
import { isSearchConsoleProviderKind, type SearchConsoleProviderKind } from "./types.js";

export interface SearchConsoleCaps {
  /** Master flag for Scout's auto-submit — default OFF. Governs whether a #13 approval is ever parked. */
  autoSubmitEnabled: boolean;
  /** Which provider to submit/verify through. `dryrun` makes no network call (no submit, no spend). */
  provider: SearchConsoleProviderKind;
  /** The owner's own workspace id (owner-first rollout marker, shared with #294), or null. */
  ownerWorkspaceId: string | null;
}

export const SEARCH_CONSOLE_DEFAULTS: SearchConsoleCaps = {
  autoSubmitEnabled: false,
  provider: "dryrun",
  ownerWorkspaceId: null,
};

export function resolveSearchConsoleCaps(cfg: SeoConfig | undefined): SearchConsoleCaps {
  const provider = cfg?.searchConsoleProvider;
  return {
    autoSubmitEnabled: cfg?.autoSubmitSitemap ?? SEARCH_CONSOLE_DEFAULTS.autoSubmitEnabled,
    provider:
      provider && isSearchConsoleProviderKind(provider) ? provider : SEARCH_CONSOLE_DEFAULTS.provider,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? SEARCH_CONSOLE_DEFAULTS.ownerWorkspaceId,
  };
}

/**
 * Whether Scout may auto-submit for THIS workspace. Pure + total. True only when the master flag is ON and
 * the workspace is the owner's own (or no owner pin is configured = the feature applies fleet-wide once an
 * owner deliberately enables it). This is the owner-workspace-first rollout gate (mirrors #228/#295).
 */
export function searchConsoleAutoSubmitEnabledForWorkspace(
  caps: SearchConsoleCaps,
  workspaceId: string,
): boolean {
  if (!caps.autoSubmitEnabled) return false;
  return caps.ownerWorkspaceId === null || caps.ownerWorkspaceId === workspaceId;
}
