/**
 * Run-timeout / lifecycle module (issue #635) — public surface.
 *
 * A self-contained feature (the #670/#674 convention): owns its own table (`default.ts`), reads config
 * from the environment (`caps.ts`), and exposes no route — callers import the service and drive it
 * (start/step/heartbeat/complete) plus a periodic {@link RunTimeoutService.sweep} that times out hung
 * runs and frees their resources. Wiring it to the scheduler + worktree/lock release is a one-liner left
 * to the integrator, so this change touches no migration, schema barrel, or app-wiring registry.
 */

export { decideTimeout, formatDuration, type TimeoutDecision } from "./decide.js";
export {
  RunTimeoutService,
  RunTimeoutError,
  type RunTimeoutServiceOptions,
  type SweepResult,
  type TimedOutRun,
} from "./service.js";
export { InMemoryRunTimeoutStore, type RunTimeoutStore } from "./store.js";
export {
  createResourceReleaser,
  NOOP_RESOURCE_RELEASER,
  type ReleaseHandle,
  type ReleaseLogger,
  type ReleaseOutcome,
  type ResourceReleaser,
  type ResourceReleaserOptions,
} from "./resources.js";
export {
  resolveRunTimeoutCaps,
  RUN_TIMEOUT_DEFAULTS,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  type RunTimeoutCaps,
} from "./caps.js";
export {
  createDefaultRunTimeoutService,
  PgRunTimeoutStore,
} from "./default.js";
export {
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
  type RunLifecycleStatus,
  type RunTimeoutPatch,
  type RunTimeoutRecord,
  type StartRunInput,
  type TimeoutDiagnostics,
  type TimeoutKind,
} from "./types.js";
