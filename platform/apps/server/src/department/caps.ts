import type { DepartmentConfig } from "../config/schema.js";
import {
  resolveDepartmentRoster,
  type DepartmentPersona,
  type DepartmentPersonaOverride,
} from "./blueprint.js";

/**
 * Resolve the named-department roster policy (#371, ADR-0371) from the layered config (#58) with hard
 * defaults — mirrors `agentRegistry/caps.ts` / `skillopt/caps.ts`. **`enabled` defaults OFF** and
 * **owner-workspace-first** (`ownerWorkspaceOnly: true`): a deployment that sets no `department` block
 * seeds the team for NOBODY, so today's behavior is byte-for-byte unchanged. Even when `enabled`, an
 * `ownerWorkspaceOnly` deployment (the default) only seeds the named owner workspace; enabling WITHOUT
 * naming the owner seeds nobody — the safest default. ipop.ai opts in via the managed layer /
 * `RELOAD_DEPARTMENT_ENABLED`, reusing the established #258 owner marker.
 *
 * The catalog (the roster + the rail) is always READABLE regardless of the flag (harmless, no IO); the
 * flag only gates whether the seed may CREATE the personas for a workspace.
 */
export interface DepartmentCaps {
  /** The seed feature flag — the roster lists regardless; seeding is OFF unless this is true. */
  enabled: boolean;
  /** Restrict seeding to the owner workspace first (default true). */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id (owner-first rollout marker), or null. */
  ownerWorkspaceId: string | null;
  /** The effective roster (defaults with any config name/role/color overrides applied). */
  roster: readonly DepartmentPersona[];
}

export const DEPARTMENT_DEFAULTS = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null as string | null,
};

export function resolveDepartmentCaps(cfg: DepartmentConfig | undefined): DepartmentCaps {
  const d = DEPARTMENT_DEFAULTS;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? d.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
    roster: resolveDepartmentRoster(cfg?.roster as readonly DepartmentPersonaOverride[] | undefined),
  };
}

/** Is this workspace the owner's own (the owner-workspace-first rollout)? Pure + total. */
export function isOwnerWorkspace(caps: DepartmentCaps, workspaceId: string): boolean {
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}

/**
 * May the team be seeded for this workspace? Fail-closed: the flag must be on AND the workspace in scope
 * (`ownerWorkspaceOnly` ⇒ only the named owner workspace; turning `enabled` on without naming the owner
 * seeds nobody). Pure + total — the single gate the route/service consults before any create.
 */
export function isDepartmentSeedEnabledForWorkspace(caps: DepartmentCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (caps.ownerWorkspaceOnly) return isOwnerWorkspace(caps, workspaceId);
  return true;
}
