/**
 * Run-timeout config (issue #635). Deliberately **self-contained**: every knob is read straight from
 * the process environment so this feature adds NO edit to the shared `config/schema.ts` barrel — keeping
 * the #635 change set free of parallel-merge conflicts with sibling branches (the #670 convention).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs
 * an inert sweeper that transitions nothing. Turning it on (`RUN_TIMEOUT_ENABLED=1`) is all it takes to
 * start reaping hung runs against the default budgets.
 */

/** Default per-run wall-clock budget: 30 minutes. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** Default per-step budget: 5 minutes. */
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000;
/** Default sweep cadence: every 30 seconds. */
export const DEFAULT_SWEEP_INTERVAL_MS = 30 * 1000;

export interface RunTimeoutCaps {
  /** Master switch for the sweeper. OFF by default. */
  enabled: boolean;
  /** Per-run wall-clock budget (ms) applied when a run does not specify its own. */
  runTimeoutMs: number;
  /** Per-step budget (ms) applied when a run does not specify its own. */
  stepTimeoutMs: number;
  /** How often the sweep should run (ms) — consumed by whoever schedules {@link RunTimeoutService.sweep}. */
  sweepIntervalMs: number;
}

export const RUN_TIMEOUT_DEFAULTS: RunTimeoutCaps = {
  enabled: false,
  runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
  stepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_MS,
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a positive-integer ms env value; a missing/invalid/non-positive value keeps the supplied default. */
function envPositiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

/** Resolve the run-timeout caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveRunTimeoutCaps(env: NodeJS.ProcessEnv = process.env): RunTimeoutCaps {
  return {
    enabled: envFlag(env.RUN_TIMEOUT_ENABLED),
    runTimeoutMs: envPositiveMs(env.RUN_TIMEOUT_RUN_MS, RUN_TIMEOUT_DEFAULTS.runTimeoutMs),
    stepTimeoutMs: envPositiveMs(env.RUN_TIMEOUT_STEP_MS, RUN_TIMEOUT_DEFAULTS.stepTimeoutMs),
    sweepIntervalMs: envPositiveMs(env.RUN_TIMEOUT_SWEEP_INTERVAL_MS, RUN_TIMEOUT_DEFAULTS.sweepIntervalMs),
  };
}
