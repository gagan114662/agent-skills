/**
 * Connect-once LIVE-flow policy (#258 Stage 2, ADR-0258). The #258 Stage 1 connection model (descriptors +
 * the internal paste path) shipped already; this governs whether the **live customer-OAuth connect flow** —
 * the one that actually mints a real credential and seals it into the #192 vault — is enabled.
 *
 * It ships **default OFF, owner-workspace-first** (mirrors `skillopt`/`delivery`/`connectClaude`). A
 * deployment that sets nothing keeps today's behavior exactly: every customer connector renders the honest
 * `coming_soon` (the Stage 1 stub). Even when `enabled`, an `ownerWorkspaceOnly` deployment (the default)
 * only lets the live flow run for the named owner workspace — so the owner dogfoods the real connect on
 * their own workspace first, and every other tenant still sees `coming_soon`.
 *
 * The live connect itself ALWAYS pauses for an explicit owner approval (a structural always-gate enforced by
 * {@link ConnectOnceService}, not a money gate — connecting touches a real external surface, premortem #200
 * §4). This flag is the master switch that decides whether the gated live path is even offered; turning it
 * on does NOT bypass the per-connect approval. Pure ⇒ unit-testable.
 */
import type { ConnectOnceConfig } from "../config/schema.js";

export interface ConnectOnceCaps {
  /** Master flag for the live customer-OAuth connect flow. OFF by default (Stage 1 `coming_soon` stays). */
  enabled: boolean;
  /**
   * Roll out owner-workspace-first (the default): when true, the live flow is offered ONLY for
   * `ownerWorkspaceId`; every other tenant keeps the `coming_soon` stub even when `enabled`. Set false to
   * offer the live flow to all tenants.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the live flow dogfoods here first, or null. */
  ownerWorkspaceId: string | null;
}

export const CONNECT_ONCE_DEFAULTS: ConnectOnceCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
};

export function resolveConnectOnceCaps(cfg: ConnectOnceConfig | undefined): ConnectOnceCaps {
  const d = CONNECT_ONCE_DEFAULTS;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? d.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
  };
}

/**
 * Pure + total + fail-closed: is the live connect flow in scope for this workspace? Disabled ⇒ never;
 * owner-first ⇒ ONLY the configured owner workspace (so an unset `ownerWorkspaceId` lets nobody in, never
 * everybody — the safest default, matching `skillopt`/`delivery`/`connectClaude`).
 */
export function isConnectOnceLiveInScope(caps: ConnectOnceCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}
