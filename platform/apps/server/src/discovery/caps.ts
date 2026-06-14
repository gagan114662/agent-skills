import type { DiscoveryConfig } from "../config/schema.js";

/**
 * Resolve the Customer Discovery Engine policy (#222, ADR-0222) from the layered config (#58) with hard
 * defaults — mirrors `growth/caps.ts`. **`enabled` defaults OFF**, but (like the growth loop) it gates
 * only the PROACTIVE posture: signal ingest, the ranked-queue read, PQL detection and the downstream
 * growth-funnel emission are ALWAYS live when the engine is exercised. A workspace that ingests no signals
 * is byte-for-byte unchanged, so a deployment that sets no `discovery` block keeps today's behavior
 * exactly. `queueLimit` caps the daily top-N queue; `defaultWindowDays` is the lookback a signal
 * definition uses when it sets none; `ownerWorkspaceId` marks the owner's own workspace.
 */
export interface DiscoveryCaps {
  /** Proactive-posture flag (reserved for the #225 outreach-prep tick). Ingest/reads stay live when off. */
  enabled: boolean;
  /** Max rows the daily ranked discovery queue returns. */
  queueLimit: number;
  /** Default lookback window (days) a signal definition uses when it specifies none. */
  defaultWindowDays: number;
  /** The owner's own workspace id (owner-first rollout marker), or null. */
  ownerWorkspaceId: string | null;
}

export const DISCOVERY_DEFAULTS: DiscoveryCaps = {
  enabled: false,
  queueLimit: 50,
  defaultWindowDays: 14,
  ownerWorkspaceId: null,
};

export function resolveDiscoveryCaps(cfg: DiscoveryConfig | undefined): DiscoveryCaps {
  const d = DISCOVERY_DEFAULTS;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    queueLimit: cfg?.queueLimit ?? d.queueLimit,
    defaultWindowDays: cfg?.defaultWindowDays ?? d.defaultWindowDays,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
  };
}

/** Is this workspace the owner's own (the owner-workspace-first rollout)? */
export function isOwnerWorkspace(caps: DiscoveryCaps, workspaceId: string): boolean {
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}
