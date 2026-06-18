/**
 * Ads spend policy caps (#272, ADR-0272). The non-secret knobs that decide whether Bid's money-gated ad
 * spend is even offered for a workspace, and the HARD per-action money cap the system never crosses.
 *
 * Two INDEPENDENT default-OFF switches, defense in depth (premortem #200 §4 — money is irreversible):
 *   - `enabled` (default false) + `ownerWorkspaceOnly` (default true): the spend path rolls out
 *     owner-workspace-first, exactly like `connectOnce`/`provisioning`/`delivery`. A deployment that sets
 *     nothing offers no ad-spend path at all.
 *   - `perActionCapCents` (default 0): the explicit per-action ceiling. Even when `enabled` AND in scope,
 *     NO spend can be approved through the agent path until the owner explicitly raises this cap, and a
 *     request above it is refused outright — the agent path can never approve past the configured ceiling.
 *
 * Pure ⇒ unit-testable; the IO (config load, vault read) lives in `default.ts`.
 */
import type { AdsConfig } from "../config/schema.js";

export interface AdsCaps {
  /** Master flag for the money-gated ad-spend path. OFF by default. */
  enabled: boolean;
  /**
   * Roll out owner-workspace-first (the default): when true, the spend path is offered ONLY for
   * `ownerWorkspaceId`; set false to broaden to all tenants.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the spend path dogfoods here first, or null. */
  ownerWorkspaceId: string | null;
  /**
   * The HARD per-action money cap in cents — the ceiling the system NEVER crosses. A single spend /
   * budget-raise / campaign-launch above this is refused (not even approvable through the agent path);
   * the owner must raise the cap in config. Defaults to 0 (fail-closed: no spend until explicitly set).
   */
  perActionCapCents: number;
}

export const ADS_DEFAULTS: AdsCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
  perActionCapCents: 0,
};

export function resolveAdsCaps(cfg: AdsConfig | undefined): AdsCaps {
  const d = ADS_DEFAULTS;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? d.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
    perActionCapCents: cfg?.perActionCapCents ?? d.perActionCapCents,
  };
}

/**
 * Pure + total + fail-closed: is the ad-spend path in scope for this workspace? Disabled ⇒ never;
 * owner-first ⇒ ONLY the configured owner workspace (so an unset `ownerWorkspaceId` lets nobody in, never
 * everybody — the safest default, matching `connectOnce`/`provisioning`/`delivery`).
 */
export function isAdsEnabledForWorkspace(caps: AdsCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}

/** The hard per-action cap, clamped to a non-negative integer count of cents. Pure + total. */
export function adsPerActionCapCents(caps: AdsCaps): number {
  const cents = Math.floor(caps.perActionCapCents);
  return Number.isFinite(cents) && cents > 0 ? cents : 0;
}
