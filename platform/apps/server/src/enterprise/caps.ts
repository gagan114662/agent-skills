/**
 * Resolved enterprise-layer policy (issue #340, ADR-0340). Fills the hard defaults the config partial omits.
 * **Default OFF, owner-workspace-first** (mirrors `provisioning`/`finance`): a workspace that sets nothing
 * meters nothing live, enforces no cap, and leaves the Passport gate open — every path the enterprise layer
 * governs degrades to today's behavior. Turning `enabled` on WITHOUT naming the owner workspace governs
 * NObody (the safest default). The live metering + cap-enforcement + IdP-gating paths are all flag-gated.
 *
 * Pure + dependency-free so the rollout is unit-testable without a DB.
 */

import type { EnterpriseConfig } from "../config/schema.js";

/** The resolved, hard-defaulted enterprise policy the service consumes. */
export interface EnterpriseCaps {
  /** Master switch for live metering + cap enforcement + the read surface — default OFF. */
  enabled: boolean;
  /** Restrict the enterprise layer to the owner workspace (default true). False ⇒ all tenants. */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the enterprise layer rolls out owner-workspace-first. */
  ownerWorkspaceId: string | null;
  /** Enforce the Passport IdP/SSO gate (in addition to the master flag) — default OFF. */
  passportEnabled: boolean;
  /** The IdP providers the Passport gate trusts (normalized: trimmed, lower-cased, de-blanked). */
  allowedIdpProviders: string[];
  /** A default per-customer budget cap (cents) when none is explicitly provisioned, or null for no default. */
  defaultCustomerCapCents: number | null;
  /** A default per-agent budget cap (cents) when none is explicitly provisioned, or null for no default. */
  defaultAgentCapCents: number | null;
  /** Max usage rows a single read returns. */
  usageListLimit: number;
}

export const ENTERPRISE_DEFAULTS: EnterpriseCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
  passportEnabled: false,
  allowedIdpProviders: ["google"],
  defaultCustomerCapCents: null,
  defaultAgentCapCents: null,
  usageListLimit: 200,
};

/** Normalize a list of provider handles: trim, lower-case, drop blanks, de-dupe (order-preserving). */
function normalizeProviders(list: readonly string[] | undefined): string[] {
  if (!list) return [...ENTERPRISE_DEFAULTS.allowedIdpProviders];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const v = raw.trim().toLowerCase();
    if (v.length > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

/** A cap cents value is kept only when it is a positive finite integer; anything else ⇒ null (no cap). */
function normalizeCapCents(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

/** Resolve the config partial into a total {@link EnterpriseCaps}, applying the safe defaults. */
export function resolveEnterpriseCaps(cfg: EnterpriseConfig | undefined): EnterpriseCaps {
  return {
    enabled: cfg?.enabled ?? ENTERPRISE_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? ENTERPRISE_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? ENTERPRISE_DEFAULTS.ownerWorkspaceId,
    passportEnabled: cfg?.passportEnabled ?? ENTERPRISE_DEFAULTS.passportEnabled,
    allowedIdpProviders: normalizeProviders(cfg?.allowedIdpProviders),
    defaultCustomerCapCents: normalizeCapCents(cfg?.defaultCustomerCapCents),
    defaultAgentCapCents: normalizeCapCents(cfg?.defaultAgentCapCents),
    usageListLimit: cfg?.usageListLimit ?? ENTERPRISE_DEFAULTS.usageListLimit,
  };
}

/**
 * Whether the enterprise layer is active for this workspace. DEFAULT OFF, owner-first: the master flag must be
 * on AND the workspace in scope (owner-only by default). Turning the flag on without naming the owner ⇒ active
 * for NObody. Pure + total.
 */
export function isEnterpriseEnabledForWorkspace(caps: EnterpriseCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}

/**
 * Whether the Passport IdP/SSO gate is ENFORCED for this workspace. Requires the master enterprise flag AND
 * the dedicated `passportEnabled` flag AND the workspace in scope — so a workspace can meter without yet
 * enforcing SSO, but can never enforce SSO while the enterprise layer is off. Pure + total.
 */
export function isPassportEnabledForWorkspace(caps: EnterpriseCaps, workspaceId: string): boolean {
  return caps.passportEnabled && isEnterpriseEnabledForWorkspace(caps, workspaceId);
}
