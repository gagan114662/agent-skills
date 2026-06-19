import type { AttributionConfig } from "../config/schema.js";

/**
 * Resolve the attributed-revenue ledger policy (#386, ADR-0386) from the layered config (#58), applying
 * hard defaults — mirrors `finance/caps.ts`. **Default OFF, owner-workspace-first**: a deployment that
 * sets no `attribution` block stamps no tracking ids and the read/projection surface stays dark, so prod
 * is byte-for-byte unchanged. `enabled` is the master switch. Even when enabled this adds no money path —
 * it only projects credit over receipts that already exist (the #98 Stripe webhook → `revenue_events`).
 */
export interface AttributionCaps {
  /** Master flag for tracking-id stamping + the attribution projection/read surface. OFF by default. */
  enabled: boolean;
  /** The owner workspace this is active for (fail-closed: unset ⇒ nobody, like #189 acquisition). */
  ownerWorkspaceId: string | null;
  /** Max age (days) between an exposure and a payment for credit to flow — stale chains don't attribute. */
  maxChainAgeDays: number;
  /** Default UTM source stamped when an artifact channel doesn't override it. */
  defaultUtmSource: string;
  /** Max rows an attribution read returns. */
  listLimit: number;
}

export const ATTRIBUTION_DEFAULTS: AttributionCaps = {
  enabled: false,
  ownerWorkspaceId: null,
  maxChainAgeDays: 90,
  defaultUtmSource: "ipop",
  listLimit: 500,
};

export function resolveAttributionCaps(cfg: AttributionConfig | undefined): AttributionCaps {
  return {
    enabled: cfg?.enabled ?? ATTRIBUTION_DEFAULTS.enabled,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? ATTRIBUTION_DEFAULTS.ownerWorkspaceId,
    maxChainAgeDays: cfg?.maxChainAgeDays ?? ATTRIBUTION_DEFAULTS.maxChainAgeDays,
    defaultUtmSource: cfg?.defaultUtmSource ?? ATTRIBUTION_DEFAULTS.defaultUtmSource,
    listLimit: cfg?.listLimit ?? ATTRIBUTION_DEFAULTS.listLimit,
  };
}

/** Owner-workspace-first gate (fail-closed): a workspace earns attribution only if it is the named owner. */
export function isOwnerWorkspace(caps: AttributionCaps, workspaceId: string): boolean {
  if (!caps.ownerWorkspaceId) return false;
  return caps.ownerWorkspaceId === workspaceId;
}

/** Convenience: attribution runs for this workspace iff enabled AND it is the owner workspace. */
export function attributionActive(caps: AttributionCaps, workspaceId: string): boolean {
  return caps.enabled && isOwnerWorkspace(caps, workspaceId);
}

/** The chain-age cap expressed in milliseconds, for {@link ../attribution/chain.attributeRevenue}. */
export function maxChainAgeMs(caps: AttributionCaps): number {
  return caps.maxChainAgeDays * 24 * 60 * 60 * 1000;
}
