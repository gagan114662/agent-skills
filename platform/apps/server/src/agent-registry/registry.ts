/**
 * The agent registry (#282, ADR-0282) — a **pure** projection of the fleet contracts onto one workspace:
 * which agents are present (seeded), and which are enabled for discovery + A2A calls under the feature
 * flag (default OFF, owner-workspace-first). Mirrors `marketing/roster.ts buildMarketingRoster`, but it
 * carries the full {@link AgentContract} and an `enabled` flag the A2A decision reads.
 *
 * "Enabled per workspace" is derived, not stored (the same call ADR-0012 made for the external AgentCard):
 * a registry is `present personas × the blueprint × the caps`, computed on read, so it can never drift
 * from the seeded roster and needs no table/migration.
 */
import { agentContracts, contractForHandle, type AgentContract } from "./contract.js";

/** One agent in a workspace's registry: its contract, whether it is seeded, and whether A2A is enabled. */
export interface RegistryEntry {
  contract: AgentContract;
  /** True when this agent persona has been seeded in the workspace (it can be @mentioned). */
  present: boolean;
  /**
   * True when this agent may be discovered + targeted by an A2A call: the feature flag is on AND the
   * agent is present AND (the workspace is the owner workspace OR the owner-first restriction is off).
   */
  enabled: boolean;
}

/** A workspace's resolved registry plus pure lookup helpers. */
export interface AgentRegistry {
  entries: RegistryEntry[];
  /** Find the entry for an @handle (present or not), or undefined when the handle is not a fleet agent. */
  findEntry(handle: string): RegistryEntry | undefined;
  /** The handles that are enabled for A2A in this workspace. */
  enabledHandles(): string[];
}

export interface BuildRegistryInput {
  /** The fleet @handles seeded in this workspace (from `listPersonas`, filtered to fleet handles). */
  presentHandles: readonly string[];
  /** The feature flag — registry discovery + A2A is OFF unless this is true. */
  registryEnabled: boolean;
  /** Whether this workspace is the owner's own (the owner-first rollout marker). */
  isOwnerWorkspace: boolean;
  /** When true (the default), only the owner workspace may enable the registry. */
  ownerWorkspaceOnly: boolean;
}

/**
 * Build the registry for one workspace. Pure + total: with `registryEnabled:false` every entry is
 * `enabled:false` (the catalog still lists, read-only), so a deployment that sets nothing exposes the
 * contracts for inspection but enables no A2A — byte-for-byte today's behavior.
 */
export function buildAgentRegistry(input: BuildRegistryInput): AgentRegistry {
  const present = new Set(input.presentHandles);
  const ownerOk = input.isOwnerWorkspace || !input.ownerWorkspaceOnly;

  const entries: RegistryEntry[] = agentContracts().map((contract) => {
    const isPresent = present.has(contract.handle);
    return {
      contract,
      present: isPresent,
      enabled: input.registryEnabled && isPresent && ownerOk,
    };
  });

  return {
    entries,
    findEntry: (handle) => entries.find((e) => e.contract.handle === handle),
    enabledHandles: () => entries.filter((e) => e.enabled).map((e) => e.contract.handle),
  };
}

/** A registry entry by handle even when it isn't built into a workspace registry (catalog lookups). */
export function catalogContract(handle: string): AgentContract | undefined {
  return contractForHandle(handle);
}
