/**
 * Shared-state locking / concurrency module (issue #639) — public surface.
 *
 * A self-contained feature (the #635/#670/#643 convention): owns its own table (`default.ts`), reads
 * config from the environment (`caps.ts`), and exposes no route — callers import {@link StateLockService}
 * and route their shared-state writes through `update(workspaceId, key, mutator)`, which serializes them
 * per entity (in-process {@link KeyedMutex}) and commits via an optimistic version compare-and-swap
 * (cross-process), enforcing consistency invariants on every transition. Concurrent writers therefore
 * can't interleave or lose updates; contention only costs bounded retries. Wiring it to the modules that
 * share mutable state is a one-liner left to the integrator, so this change touches no migration, schema
 * barrel, or app-wiring registry.
 */

export {
  StateLockService,
  StateLockError,
  type StateLockServiceOptions,
  type StateMutator,
} from "./service.js";
export { KeyedMutex, type CriticalSection } from "./mutex.js";
export {
  InMemorySharedStateStore,
  type SharedStateStore,
} from "./store.js";
export {
  checkRecord,
  checkTransition,
  checkVersionHistory,
  assertRecord,
  assertTransition,
} from "./invariants.js";
export {
  resolveStateLockCaps,
  STATE_LOCK_DEFAULTS,
  DEFAULT_MAX_RETRIES,
  type StateLockCaps,
} from "./caps.js";
export { createDefaultStateLockService, PgSharedStateStore } from "./default.js";
export {
  StateNotFoundError,
  StateExistsError,
  StateConflictError,
  InvariantViolationError,
  type SharedStateRecord,
  type CreateStateInput,
} from "./types.js";
