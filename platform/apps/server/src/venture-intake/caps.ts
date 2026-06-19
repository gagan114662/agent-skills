import type { VentureIntakeConfig } from "../config/schema.js";

/**
 * Resolve the venture-intake surface policy (#387, ADR-0387) from the layered config (#58), applying
 * hard defaults — mirrors `attribution/caps.ts`. **Default OFF, owner-workspace-first**: a deployment
 * that sets no `ventureIntake` block keeps the owner-facing brief submit route gated (409) and the web
 * surface dark, so prod is byte-for-byte unchanged. `enabled` is the master switch.
 *
 * This block adds NO new pipeline and NO money/irreversible action — it only surfaces the already-built
 * #96 venture loop intake so the owner can brief ANY company idea (not just marketing). Submit + heuristic
 * score + epic emission are existing non-money paths; the funded build work still flows through the
 * existing #13 gate.
 */
export interface VentureIntakeCaps {
  /** Master flag for the owner-facing venture-brief submit route + web surface. OFF by default. */
  enabled: boolean;
  /** The owner workspace this is active for (fail-closed: unset ⇒ nobody, like #386 attribution). */
  ownerWorkspaceId: string | null;
}

export const VENTURE_INTAKE_DEFAULTS: VentureIntakeCaps = {
  enabled: false,
  ownerWorkspaceId: null,
};

export function resolveVentureIntakeCaps(
  cfg: VentureIntakeConfig | undefined,
): VentureIntakeCaps {
  return {
    enabled: cfg?.enabled ?? VENTURE_INTAKE_DEFAULTS.enabled,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? VENTURE_INTAKE_DEFAULTS.ownerWorkspaceId,
  };
}

/** Owner-workspace-first gate (fail-closed): a workspace earns the brief surface only if it is the owner. */
export function isOwnerWorkspace(caps: VentureIntakeCaps, workspaceId: string): boolean {
  if (!caps.ownerWorkspaceId) return false;
  return caps.ownerWorkspaceId === workspaceId;
}

/** Convenience: the venture-intake surface runs for this workspace iff enabled AND it is the owner ws. */
export function ventureIntakeActive(caps: VentureIntakeCaps, workspaceId: string): boolean {
  return caps.enabled && isOwnerWorkspace(caps, workspaceId);
}
