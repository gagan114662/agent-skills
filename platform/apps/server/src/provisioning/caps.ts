/**
 * Resolved central-provisioning policy (issue #267, ADR-0267). Fills the hard defaults the config partial
 * omits. **Default OFF, owner-workspace-first** (mirrors `delivery`/`reach`/`finance`): a workspace that
 * sets nothing provisions nothing — every capability resolves `unprovisioned` and the per-department
 * adapters fall back to their free `mock`/`dryrun` path. Turning `enabled` on WITHOUT naming the owner
 * workspace provisions to NObody (the safest default), exactly like the delivery gate.
 *
 * Pure + dependency-free so the rollout is unit-testable without a DB.
 */

import { MOCK_PROVIDER } from "./registry.js";

/** The non-secret provisioning config shape (mirrors `config/schema.ts provisioningSchema`). */
export interface ProvisioningConfigInput {
  /** Master switch — default OFF. */
  enabled?: boolean;
  /** Restrict central provisioning to the owner workspace (default true). False ⇒ broaden to all tenants. */
  ownerWorkspaceOnly?: boolean;
  /** The owner's own workspace id — provisioning rolls out owner-workspace-first. ALSO the vault tenant
   *  the central `central:<provider>` credentials are read from. */
  ownerWorkspaceId?: string;
  /**
   * Which provider fulfils each capability, e.g. `{ keyword_data: "dataforseo" }`. Config-supplied so a
   * per-department PR activates a real provider WITHOUT a code change here. A capability absent from this
   * map (or mapped to a blank) stays on the free `mock` provider. NEVER holds a key — only a provider id.
   */
  providerByCapability?: Record<string, string>;
}

/** Resolved provisioning policy — the hard-defaulted shape the service + decide consume. */
export interface ProvisioningCaps {
  enabled: boolean;
  ownerWorkspaceOnly: boolean;
  ownerWorkspaceId: string | null;
  providerByCapability: Record<string, string>;
}

export const PROVISIONING_DEFAULTS: ProvisioningCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
  providerByCapability: {},
};

/** Resolve the config partial into a total {@link ProvisioningCaps}, applying the safe defaults. */
export function resolveProvisioningCaps(cfg: ProvisioningConfigInput | undefined): ProvisioningCaps {
  const providerByCapability: Record<string, string> = {};
  for (const [cap, provider] of Object.entries(cfg?.providerByCapability ?? {})) {
    // A blank/whitespace provider id is treated as "not configured" → the capability stays on mock.
    if (typeof provider === "string" && provider.trim().length > 0) {
      providerByCapability[cap] = provider.trim();
    }
  }
  return {
    enabled: cfg?.enabled ?? PROVISIONING_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? PROVISIONING_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? PROVISIONING_DEFAULTS.ownerWorkspaceId,
    providerByCapability,
  };
}

/**
 * Whether central provisioning is active for this workspace. Two-pronged + DEFAULT OFF, owner-first: the
 * master flag must be on AND the workspace must be in scope (owner-only by default). Turning the flag on
 * without naming the owner workspace ⇒ active for NObody. Pure + total.
 */
export function isProvisioningEnabledForWorkspace(
  caps: ProvisioningCaps,
  workspaceId: string,
): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}

/**
 * The active provider id for a capability, given the resolved caps. A `customer_spend` capability has no
 * central provider (the customer's own account/budget fulfils it) so callers pass `hasCentralProvider`
 * false and get `null`. Otherwise: the config-mapped provider, else the free {@link MOCK_PROVIDER}.
 */
export function activeProvider(
  caps: ProvisioningCaps,
  capabilityId: string,
  hasCentralProvider: boolean,
): string | null {
  if (!hasCentralProvider) return null;
  return caps.providerByCapability[capabilityId] ?? MOCK_PROVIDER;
}
