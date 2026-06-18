/**
 * The department registry projection (#371, ADR-0371) — the named team's presence in the #282 agent
 * registry surface. **Pure**: it reuses the #282 {@link AgentContract} / {@link RegistryEntry} shapes
 * (the stable consumer surface) so the department personas are first-class registry entries with no drift,
 * and mirrors `agent-registry/registry.ts buildAgentRegistry` exactly: an entry is `enabled` only when the
 * flag is on AND the persona is present AND the workspace is in owner-first scope.
 *
 * The contracts are built directly from the roster (not via the marketing metadata table) because these
 * teammates are identity/display only: they carry the draft tool ceiling, a `read_only` risk tier, and an
 * empty `gatedActions` set — nothing they produce leaves the building without the #13 gate (#200). A
 * department persona whose handle coincides with a marketing fleet agent (e.g. `scout`) is the same
 * underlying member; each surface projects its own role label. Documented in ADR-0371.
 */
import type { AgentContract } from "../agent-registry/contract.js";
import type { RegistryEntry } from "../agent-registry/registry.js";
import type { DepartmentPersona } from "./blueprint.js";
import { DEPARTMENT_DRAFT_TOOLS } from "./blueprint.js";

/** Build the #282-shaped contract for one teammate. Pure — identity/display only (read-only, no gates). */
export function departmentContract(p: DepartmentPersona): AgentContract {
  return {
    handle: p.handle,
    displayName: p.displayName,
    department: p.department,
    title: p.role,
    summary: p.summary,
    // Identity/display only: the team advises in-channel; it advertises a single "advise" capability so
    // the registry has a verb, but it carries no send/spend and triggers no #13 action of its own.
    capabilities: [`${p.department}.advise`],
    inputs: [{ name: "brief", description: "What you want this teammate to look at or draft.", required: true }],
    outputs: [{ name: "draft", description: "An in-channel draft / recommendation for a human to review." }],
    tools: [...DEPARTMENT_DRAFT_TOOLS],
    costTier: "low",
    riskTier: "read_only",
    gatedActions: [],
  };
}

/** Every teammate's contract, in roster order. Pure. */
export function departmentContracts(roster: readonly DepartmentPersona[]): AgentContract[] {
  return roster.map(departmentContract);
}

export interface BuildDepartmentRegistryInput {
  roster: readonly DepartmentPersona[];
  /** The @handles seeded in this workspace (from `listPersonas`, filtered to roster handles). */
  presentHandles: readonly string[];
  /** The seed feature flag — the roster lists regardless; entries enable only when this is true. */
  enabled: boolean;
  /** Whether this workspace is the owner's own (the owner-first rollout marker). */
  isOwnerWorkspace: boolean;
  /** When true (the default), only the owner workspace may enable the team. */
  ownerWorkspaceOnly: boolean;
}

/**
 * Build the department's registry entries for one workspace. Pure + total: with `enabled:false` every
 * entry is `enabled:false` (the catalog still lists, read-only), so a deployment that sets nothing exposes
 * the roster for inspection but enables nobody — byte-for-byte today's behavior.
 */
export function buildDepartmentRegistry(input: BuildDepartmentRegistryInput): RegistryEntry[] {
  const present = new Set(input.presentHandles.map((h) => h.toLowerCase()));
  const ownerOk = input.isOwnerWorkspace || !input.ownerWorkspaceOnly;
  return input.roster.map((p) => {
    const isPresent = present.has(p.handle);
    return {
      contract: departmentContract(p),
      present: isPresent,
      enabled: input.enabled && isPresent && ownerOk,
    };
  });
}
