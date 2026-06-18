/**
 * Capability-token MINT policy (#336, ADR-0336). Governs whether the **live capability-token mint** — the
 * path that issues a real, signed, usable per-action token off a connection grant — is enabled for a
 * workspace, plus the TTL bounds every minted token is clamped to.
 *
 * It ships **default OFF, owner-workspace-first** (mirrors `connectOnce`/`delivery`/`skillopt`). A deployment
 * that sets nothing mints nothing: every mint request degrades to the honest `disabled`. Even when `enabled`,
 * an `ownerWorkspaceOnly` deployment (the default) only mints for the named owner workspace — the owner
 * dogfoods the real model first. Turning the flag on does NOT bypass the per-action constraints enforced by
 * `token-mint.ts` (a `write` token still requires a #13 pre-commitment, premortem §4). Pure ⇒ unit-testable.
 */
import type { CapabilityTokensConfig } from "../config/schema.js";

/** Hard floor/ceiling on the configurable TTL bounds — a token is always short-lived, never standing. */
export const TTL_FLOOR_SECONDS = 30;
export const TTL_CEILING_SECONDS = 60 * 60; // 1h absolute max, even if a deployment misconfigures higher.

export interface CapabilityTokenCaps {
  /** Master flag for the live token mint. OFF by default (no token is ever minted). */
  liveMintEnabled: boolean;
  /** Roll out owner-workspace-first (the default): when true, mint ONLY for `ownerWorkspaceId`. */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the mint dogfoods here first, or null. */
  ownerWorkspaceId: string | null;
  /** Default TTL applied when a request omits one (seconds), clamped into [floor, max]. */
  defaultTtlSeconds: number;
  /** Maximum TTL a request may ask for (seconds), itself clamped into [floor, ceiling]. */
  maxTtlSeconds: number;
}

export const CAPABILITY_TOKEN_DEFAULTS: CapabilityTokenCaps = {
  liveMintEnabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
  defaultTtlSeconds: 300, // 5 minutes — enough for one action, short enough to bound a leak.
  maxTtlSeconds: 900, // 15 minutes ceiling for a single delegated action.
};

/** Clamp a configured TTL into the safe range [floor, ceiling]; non-finite/≤0 falls back to `fallback`. */
function clampConfiguredTtl(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), TTL_FLOOR_SECONDS), TTL_CEILING_SECONDS);
}

export function resolveCapabilityTokenCaps(
  cfg: CapabilityTokensConfig | undefined,
): CapabilityTokenCaps {
  const d = CAPABILITY_TOKEN_DEFAULTS;
  const maxTtlSeconds = clampConfiguredTtl(cfg?.maxTtlSeconds, d.maxTtlSeconds);
  // The default TTL can never exceed the max TTL (a misconfig would otherwise mint past the ceiling).
  const defaultTtlSeconds = Math.min(clampConfiguredTtl(cfg?.defaultTtlSeconds, d.defaultTtlSeconds), maxTtlSeconds);
  return {
    liveMintEnabled: cfg?.liveMintEnabled ?? d.liveMintEnabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? d.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
    defaultTtlSeconds,
    maxTtlSeconds,
  };
}

/**
 * Pure + total + fail-closed: is the live token mint in scope for this workspace? Disabled ⇒ never;
 * owner-first ⇒ ONLY the configured owner workspace (so an unset `ownerWorkspaceId` lets nobody in, never
 * everybody — the safest default, matching `connectOnce`/`skillopt`/`delivery`).
 */
export function isCapabilityMintLiveInScope(caps: CapabilityTokenCaps, workspaceId: string): boolean {
  if (!caps.liveMintEnabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}
