/**
 * Agent role registry + task routing (issue #586) — public surface.
 *
 * A self-contained feature (the #635/#670/#674 convention): the canonical roster lives in `roles.ts`, the
 * registry is built in-process from it (`registry.ts`), and routing is a pure function (`route.ts`). It
 * owns no table, reads no environment, and exposes no route — the orchestrator imports {@link
 * defaultRoleRegistry} + {@link routeTask} and drives them on its spawn path. This change touches no
 * migration, no schema barrel, and no app-wiring registry.
 *
 * Typical use:
 *   const registry = defaultRoleRegistry();
 *   const decision = routeTask({ description, kind, requiredTools }, registry);
 *   if (decision.role) spawnAgentForRole(decision.role, registry.allowedTools(decision.role));
 */

export {
  ROLE_IDS,
  TASK_KINDS,
  type AgentRole,
  type TaskKind,
  type RoleDefinition,
  type RoutingTask,
  type RoutingConfidence,
  type RoleScore,
  type RoutingDecision,
} from "./types.js";
export { ROLE_DEFINITIONS } from "./roles.js";
export { RoleRegistry, RoleRegistryError, defaultRoleRegistry } from "./registry.js";
export { routeTask, KIND_WEIGHT, KEYWORD_WEIGHT } from "./route.js";
