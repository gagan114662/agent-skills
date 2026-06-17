import type { VentureConfig } from "../config/schema.js";
import type { VentureThresholds } from "./types.js";

/**
 * Resolve the venture policy from the layered config (#58), applying hard defaults — mirrors
 * `scale/caps.ts resolveScaleCaps`. The gate is **default OFF** (`enabled: false`): a deployment that
 * sets no `venture` section keeps today's behavior (autonomy launches are never blocked).
 */
export interface VentureCaps {
  /** The anti-demo gate flag. OFF by default. */
  enabled: boolean;
  /**
   * Roll the gate out owner-workspace-first (#228): when true (the default), the gate only enforces on
   * `ownerWorkspaceId` even if `enabled` is on — every other tenant keeps today's unblocked behavior.
   * Set false to enforce on all tenants. Mirrors `delivery`/`monetization`'s two-pronged gate.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the gate dogfoods enforcement here first. */
  ownerWorkspaceId: string | undefined;
  fund: number;
  kill: number;
  escalateBand: number;
  maxIterations: number;
  /** Weight on the adversarial Reviewer when combining the two personas (0–1). */
  reviewerWeight: number;
  /** How long a passing scorecard stays valid for the admission gate. */
  scorecardTtlMinutes: number;
  /** Estimated cost (cents) charged to tenant usage per scoring pass. */
  evaluationCostCents: number;
}

export const VENTURE_DEFAULTS: VentureCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: undefined,
  fund: 70,
  kill: 35,
  escalateBand: 10,
  maxIterations: 3,
  reviewerWeight: 0.6,
  scorecardTtlMinutes: 7 * 24 * 60, // 7 days
  evaluationCostCents: 100, // $1 estimate per scoring pass (only bites against a configured budget)
};

export function resolveVentureCaps(cfg: VentureConfig | undefined): VentureCaps {
  return {
    enabled: cfg?.enabled ?? VENTURE_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? VENTURE_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? VENTURE_DEFAULTS.ownerWorkspaceId,
    fund: cfg?.fundThreshold ?? VENTURE_DEFAULTS.fund,
    kill: cfg?.killThreshold ?? VENTURE_DEFAULTS.kill,
    escalateBand: cfg?.escalateBand ?? VENTURE_DEFAULTS.escalateBand,
    maxIterations: cfg?.maxIterations ?? VENTURE_DEFAULTS.maxIterations,
    reviewerWeight: cfg?.reviewerWeight ?? VENTURE_DEFAULTS.reviewerWeight,
    scorecardTtlMinutes: cfg?.scorecardTtlMinutes ?? VENTURE_DEFAULTS.scorecardTtlMinutes,
    evaluationCostCents: cfg?.evaluationCostCents ?? VENTURE_DEFAULTS.evaluationCostCents,
  };
}

/**
 * Pure: is the #96 admission gate ENFORCED for this specific workspace (#228)? The gate rolls out
 * owner-workspace-first — so even when the master `enabled` flag is on, an `ownerWorkspaceOnly` deployment
 * (the default) only enforces on the named owner workspace, and every other tenant keeps today's unblocked
 * behavior. Turning `enabled` on WITHOUT naming the owner workspace enforces on nobody (the safest default,
 * matching `delivery`/`monetization`). Set `ownerWorkspaceOnly` false to enforce on all tenants.
 */
export function isVentureGateEnabledForWorkspace(caps: VentureCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== undefined && caps.ownerWorkspaceId === workspaceId;
}

/** Project the decision thresholds out of the resolved caps. */
export function ventureThresholds(caps: VentureCaps): VentureThresholds {
  return {
    fund: caps.fund,
    kill: caps.kill,
    escalateBand: caps.escalateBand,
    maxIterations: caps.maxIterations,
  };
}
