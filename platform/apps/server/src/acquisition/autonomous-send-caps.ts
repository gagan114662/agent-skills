/**
 * Resolved autonomous-send policy (issue #403, ADR-0403). Fills the hard defaults the config partial omits.
 * **Default OFF, owner-workspace-first** (mirrors `enterprise`/`attribution`/`emailDeliverability`): a workspace
 * that sets nothing keeps today's behavior exactly — every outreach send falls back to the per-send #13 human
 * gate (`decideAutonomousSend` returns `gate_13`). Turning `enabled` on WITHOUT naming the owner workspace
 * enables it for NObody (the safest default).
 *
 * `windowCap` and `hardDailyCap` are the PRE-COMMITTED caps that bound an autonomous send: the system can send
 * inside them without a human, and over either one it escalates back to #13. They are the never-exceed line —
 * only a human raising them (in config) lets more through. Both default to 0 (no headroom), so even flipping
 * `enabled` on without setting caps sends NOTHING autonomously (fail-closed).
 *
 * Pure + dependency-free so the rollout is unit-testable without a DB.
 */

import type { AutonomousSendConfig } from "../config/schema.js";

/** The resolved, hard-defaulted autonomous-send policy the send path consumes. */
export interface AutonomousSendCaps {
  /** Master switch for the autonomous-send layer — default OFF (every send stays a per-send #13 human gate). */
  enabled: boolean;
  /** Restrict autonomous send to the owner workspace (default true). False ⇒ all tenants. */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — autonomous send rolls out owner-workspace-first. */
  ownerWorkspaceId: string | null;
  /** The pre-committed per-window send cap (rolling window). 0 ⇒ no autonomous headroom (fail-closed). */
  windowCap: number;
  /** The HARD never-exceed daily cap (the backstop the system can never cross autonomously). 0 ⇒ none. */
  hardDailyCap: number;
}

export const AUTONOMOUS_SEND_DEFAULTS: AutonomousSendCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
  windowCap: 0,
  hardDailyCap: 0,
};

/** A cap value is kept only when it is a non-negative finite integer; anything else ⇒ 0 (no headroom). */
function normalizeCap(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Resolve the config partial into a total {@link AutonomousSendCaps}, applying the safe defaults. */
export function resolveAutonomousSendCaps(cfg: AutonomousSendConfig | undefined): AutonomousSendCaps {
  const d = AUTONOMOUS_SEND_DEFAULTS;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? d.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
    windowCap: normalizeCap(cfg?.windowCap),
    hardDailyCap: normalizeCap(cfg?.hardDailyCap),
  };
}

/**
 * Whether the autonomous-send layer is active for this workspace. DEFAULT OFF, owner-first: the master flag
 * must be on AND the workspace in scope (owner-only by default). Turning the flag on without naming the owner
 * ⇒ active for NObody. Pure + total.
 */
export function isAutonomousSendEnabledForWorkspace(
  caps: AutonomousSendCaps,
  workspaceId: string,
): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}
