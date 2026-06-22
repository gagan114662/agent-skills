/**
 * Run-replay / reproduce-a-failed-run module (issue #668) — public surface.
 *
 * A self-contained feature (the #635/#670/#674 convention): owns its own table (`default.ts`), reads config
 * from the environment (`caps.ts`), and exposes no route — callers import the service and drive it. The
 * flow: `capture()` a run's deterministic inputs (prompt/seed/config/env) at start, `recordOutcome()` when
 * it ends, then for a failed run `prepareReplay()` returns the exact inputs to re-execute and
 * `verifyReplay()` confirms whether the failure reproduced. Wiring it to the run lifecycle is a one-liner
 * left to the integrator, so this change touches no migration, schema barrel, or app-wiring registry.
 */

export { canonicalize, fingerprint } from "./fingerprint.js";
export {
  buildCapture,
  inputByteLength,
  redactInputs,
  type BuildCaptureInput,
} from "./capture.js";
export { buildReplayPlan, isReplayable, verifyReproduction } from "./replay.js";
export { InMemoryRunReplayStore, type RunReplayStore } from "./store.js";
export {
  RunReplayService,
  RunReplayError,
  MAX_SEED,
  type RunReplayServiceOptions,
} from "./service.js";
export {
  resolveRunReplayCaps,
  RUN_REPLAY_DEFAULTS,
  DEFAULT_MAX_INPUT_BYTES,
  type RunReplayCaps,
} from "./caps.js";
export { createDefaultRunReplayService, PgRunReplayStore } from "./default.js";
export {
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
  type CapturedRun,
  type CaptureRunInput,
  type ReplayPlan,
  type ReproductionKind,
  type ReproductionVerdict,
  type RunInputs,
  type RunOutcome,
  type RunStatus,
} from "./types.js";
