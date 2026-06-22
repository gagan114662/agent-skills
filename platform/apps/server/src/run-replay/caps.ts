/**
 * Run-replay config (issue #668). Deliberately **self-contained**: every knob is read straight from the
 * process environment so this feature adds NO edit to the shared `config/schema.ts` barrel — keeping the
 * #668 change set free of parallel-merge conflicts with sibling branches (the #635/#670 convention).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing captures
 * nothing. Turning it on (`RUN_REPLAY_ENABLED=1`) is all it takes to start capturing run inputs so failed
 * runs can be reproduced.
 */

/** Default cap on a single capture's serialized inputs: 256 KiB. A capture is a record, not a blob store. */
export const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;

export interface RunReplayCaps {
  /** Master switch for capturing run inputs. OFF by default. */
  enabled: boolean;
  /**
   * The largest a single capture's canonical inputs may be (bytes). A capture exceeding this is rejected
   * at the service boundary rather than silently truncated — a partial capture can't reproduce anything.
   */
  maxInputBytes: number;
}

export const RUN_REPLAY_DEFAULTS: RunReplayCaps = {
  enabled: false,
  maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a positive-integer env value; a missing/invalid/non-positive value keeps the supplied default. */
function envPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

/** Resolve the run-replay caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveRunReplayCaps(env: NodeJS.ProcessEnv = process.env): RunReplayCaps {
  return {
    enabled: envFlag(env.RUN_REPLAY_ENABLED),
    maxInputBytes: envPositiveInt(env.RUN_REPLAY_MAX_INPUT_BYTES, RUN_REPLAY_DEFAULTS.maxInputBytes),
  };
}
