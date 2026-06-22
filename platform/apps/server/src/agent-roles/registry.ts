/**
 * The role registry (issue #586): an indexed, validated view over a set of {@link RoleDefinition}s. It is
 * the lookup surface the orchestrator uses — "what is this role's mandate?", "is this tool in this role's
 * scope?", "what outputs does it owe?" — and the object the router (`route.ts`) scores against.
 *
 * Construct it once from the canonical roster ({@link defaultRoleRegistry}) or from a custom set (tests,
 * future variants). The constructor validates the roster up front (no duplicate ids, every role non-empty)
 * so a malformed roster fails loudly at construction rather than mis-routing later. Pure and in-process —
 * no IO, no global mutable state.
 */

import { ROLE_DEFINITIONS } from "./roles.js";
import { ROLE_IDS, type AgentRole, type RoleDefinition, type TaskKind } from "./types.js";

/** Thrown when a roster is malformed, or a caller asks for a role that does not exist. */
export class RoleRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleRegistryError";
  }
}

export class RoleRegistry {
  /** Insertion-ordered map of role id → definition. */
  private readonly byId: ReadonlyMap<AgentRole, RoleDefinition>;

  /**
   * @param definitions the roster to index. Validated: ids must be unique and every role must declare a
   *   non-empty mandate and at least one allowed tool (a role with no scoped tools could never act).
   */
  constructor(definitions: readonly RoleDefinition[]) {
    if (definitions.length === 0) {
      throw new RoleRegistryError("role registry requires at least one role definition");
    }
    const map = new Map<AgentRole, RoleDefinition>();
    for (const def of definitions) {
      if (map.has(def.id)) {
        throw new RoleRegistryError(`duplicate role id "${def.id}" in roster`);
      }
      if (def.mandate.trim() === "") {
        throw new RoleRegistryError(`role "${def.id}" has an empty mandate`);
      }
      if (def.allowedTools.length === 0) {
        throw new RoleRegistryError(`role "${def.id}" has an empty allowedTools set`);
      }
      map.set(def.id, def);
    }
    this.byId = map;
  }

  /** Every role id in this registry, in roster order. */
  roleIds(): AgentRole[] {
    return [...this.byId.keys()];
  }

  /** Every role definition, in roster order. */
  list(): RoleDefinition[] {
    return [...this.byId.values()];
  }

  /** True if `role` is defined in this registry. */
  has(role: string): role is AgentRole {
    return this.byId.has(role as AgentRole);
  }

  /** The definition for `role`, or `undefined` if it is not in this registry. */
  get(role: string): RoleDefinition | undefined {
    return this.byId.get(role as AgentRole);
  }

  /** The definition for `role`, or throw {@link RoleRegistryError} if it is not defined. */
  require(role: string): RoleDefinition {
    const def = this.byId.get(role as AgentRole);
    if (!def) {
      throw new RoleRegistryError(`unknown role "${role}" (known: ${this.roleIds().join(", ")})`);
    }
    return def;
  }

  /**
   * Is `tool` within `role`'s scoped toolset? This is the least-privilege check the orchestrator runs
   * before granting an agent a tool — the heart of "each running agent has an explicit role + scoped
   * toolset". Returns `false` for an unknown role (fail closed).
   */
  toolAllowed(role: string, tool: string): boolean {
    const def = this.byId.get(role as AgentRole);
    return def ? def.allowedTools.includes(tool) : false;
  }

  /** The scoped toolset for `role` (a fresh copy; mutating it does not affect the registry). */
  allowedTools(role: string): string[] {
    return [...this.require(role).allowedTools];
  }

  /** The outputs `role` is expected to produce (a fresh copy). */
  outputsFor(role: string): string[] {
    return [...this.require(role).outputs];
  }

  /** Every role that owns the given task `kind`, in roster order (usually exactly one). */
  rolesForKind(kind: TaskKind): AgentRole[] {
    return this.list()
      .filter((def) => def.handlesTaskKinds.includes(kind))
      .map((def) => def.id);
  }
}

/** The registry built from the canonical five-role roster, ordered by {@link ROLE_IDS}. */
export function defaultRoleRegistry(): RoleRegistry {
  return new RoleRegistry(ROLE_IDS.map((id) => ROLE_DEFINITIONS[id]));
}
